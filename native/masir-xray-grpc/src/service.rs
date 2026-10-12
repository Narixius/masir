use crate::codec::RawBytesCodec;
use crate::errors::XrayError;
use bytes::Bytes;
use http::uri::PathAndQuery;
use lazy_static::lazy_static;
use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MethodDescriptor, SerializeOptions};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use tokio::runtime::Runtime;
use tonic::client::Grpc;
use tonic::transport::{Channel, Endpoint};

const DESCRIPTOR_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/xray_file_descriptor_set.bin"));

lazy_static! {
    static ref DESCRIPTOR_POOL: DescriptorPool = {
        DescriptorPool::decode(DESCRIPTOR_BYTES)
            .expect("corrupt embedded Xray file descriptor set")
    };
    static ref RUNTIME: Runtime = {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("failed to start tokio runtime")
    };
    static ref CHANNELS: Mutex<HashMap<String, Channel>> = Mutex::new(HashMap::new());
}

pub fn get_pool() -> &'static DescriptorPool {
    &DESCRIPTOR_POOL
}

fn get_or_create_channel(addr: &str) -> Result<Channel, String> {
    let mut map = CHANNELS.lock().map_err(|e| e.to_string())?;
    if let Some(ch) = map.get(addr) {
        return Ok(ch.clone());
    }

    let uri_str = if addr.starts_with("http://") || addr.starts_with("https://") {
        addr.to_string()
    } else {
        format!("http://{addr}")
    };

    let endpoint = Endpoint::from_shared(uri_str)
        .map_err(|e| format!("invalid endpoint URI '{addr}': {e}"))?
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(5));

    let channel = RUNTIME.block_on(async { endpoint.connect().await })
        .map_err(|e| format!("connect failed for '{addr}': {e}"))?;

    map.insert(addr.to_string(), channel.clone());
    Ok(channel)
}

/// Recursively expand Phase-2 `TypedMessage`s in request JSON:
/// If an object has `{"type": "...", "value": { ... }}`, encode `value` according to `type`
/// and replace `value` with raw protobuf bytes.
fn expand_typed_messages(pool: &DescriptorPool, val: &mut JsonValue) -> Result<(), String> {
    match val {
        JsonValue::Object(map) => {
            let type_name_opt = map.get("type").and_then(|t| t.as_str()).map(|s| s.to_string());
            if let Some(type_name) = type_name_opt {
                if let Some(val_node) = map.get_mut("value") {
                    if val_node.is_object() {
                        let desc = pool.get_message_by_name(&type_name)
                            .ok_or_else(|| format!("unknown TypedMessage type: '{type_name}'"))?;
                        
                        expand_typed_messages(pool, val_node)?;
                        
                        let val_str = val_node.to_string();
                        let mut deserializer = serde_json::Deserializer::from_str(&val_str);
                        let inner_msg = DynamicMessage::deserialize(desc, &mut deserializer)
                            .map_err(|e| format!("failed to serialize TypedMessage value for '{type_name}': {e}"))?;
                        
                        let encoded_bytes = inner_msg.encode_to_vec();
                        use base64::Engine;
                        let b64_str = base64::engine::general_purpose::STANDARD.encode(&encoded_bytes);
                        *val_node = JsonValue::String(b64_str);
                    }
                }
            } else {
                for (_, v) in map.iter_mut() {
                    expand_typed_messages(pool, v)?;
                }
            }
        }
        JsonValue::Array(arr) => {
            for v in arr.iter_mut() {
                expand_typed_messages(pool, v)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn find_method(pool: &DescriptorPool, method: &str) -> Option<MethodDescriptor> {
    let trimmed = method.trim_start_matches('/');
    // e.g. "xray.app.stats.command.StatsService/GetSysStats"
    let (service_name, method_name) = trimmed.rsplit_once('/')?;
    let service = pool.get_service_by_name(service_name)?;
    service.methods().find(|m| m.name() == method_name)
}

/// Recursively unpack Phase-2 `TypedMessage`s in response JSON if possible.
fn unpack_typed_messages(pool: &DescriptorPool, val: &mut JsonValue) {
    match val {
        JsonValue::Object(map) => {
            if let (Some(JsonValue::String(type_name)), Some(val_node)) = (map.get("type").cloned(), map.get("value").cloned()) {
                if let Some(desc) = pool.get_message_by_name(&type_name) {
                    let bytes_opt = match val_node {
                        JsonValue::String(b64_str) => {
                            use base64::Engine;
                            base64::engine::general_purpose::STANDARD.decode(b64_str).ok()
                        }
                        JsonValue::Array(byte_arr) => {
                            Some(byte_arr.iter().filter_map(|b| b.as_u64().map(|n| n as u8)).collect())
                        }
                        _ => None,
                    };

                    if let Some(bytes) = bytes_opt {
                        if let Ok(dyn_msg) = DynamicMessage::decode(desc, &bytes[..]) {
                            let opts = SerializeOptions::new()
                                .skip_default_fields(false)
                                .stringify_64_bit_integers(true);
                            if let Ok(deserialized_json) = dyn_msg.serialize_with_options(serde_json::value::Serializer, &opts) {
                                map.insert("value".to_string(), deserialized_json);
                            }
                        }
                    }
                }
            }
            for (_, v) in map.iter_mut() {
                unpack_typed_messages(pool, v);
            }
        }
        JsonValue::Array(arr) => {
            for v in arr.iter_mut() {
                unpack_typed_messages(pool, v);
            }
        }
        _ => {}
    }
}

pub fn execute_unary_call(
    addr: &str,
    method: &str,
    req_json_str: &str,
) -> Result<String, (XrayError, String)> {
    let pool = get_pool();
    let method_desc = find_method(pool, method)
        .ok_or_else(|| (XrayError::UnknownMethod, format!("method '{method}' not found in descriptor pool")))?;

    let input_desc = method_desc.input();
    let output_desc = method_desc.output();

    // Parse input JSON into serde_json::Value to allow TypedMessage expansion
    let mut req_val: JsonValue = if req_json_str.trim().is_empty() {
        JsonValue::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(req_json_str)
            .map_err(|e| (XrayError::BadJson, format!("invalid request JSON: {e}")))?
    };

    expand_typed_messages(pool, &mut req_val)
        .map_err(|e| (XrayError::BadJson, e))?;

    let req_val_str = req_val.to_string();
    let mut deserializer = serde_json::Deserializer::from_str(&req_val_str);
    let req_msg = DynamicMessage::deserialize(input_desc, &mut deserializer)
        .map_err(|e| (XrayError::BadJson, format!("failed to map JSON into protobuf message: {e}")))?;

    let req_bytes = Bytes::from(req_msg.encode_to_vec());

    let channel = get_or_create_channel(addr)
        .map_err(|e| (XrayError::Connect, e))?;

    let path = PathAndQuery::from_str(method)
        .map_err(|e| (XrayError::BadArgument, format!("invalid method path: {e}")))?;

    let res_bytes = RUNTIME.block_on(async {
        let mut client = Grpc::new(channel);
        client.ready().await.map_err(|e| (XrayError::Connect, format!("service not ready: {e}")))?;
        let response = client.unary(tonic::Request::new(req_bytes), path, RawBytesCodec)
            .await
            .map_err(|status| (XrayError::GrpcStatus, format!("gRPC status {}: {}", status.code(), status.message())))?;
        Ok(response.into_inner())
    })?;

    let res_msg = DynamicMessage::decode(output_desc, res_bytes)
        .map_err(|e| (XrayError::BadJson, format!("failed to decode response proto: {e}")))?;

    let serialize_opts = SerializeOptions::new()
        .skip_default_fields(false)
        .stringify_64_bit_integers(true);

    let mut res_json_val = res_msg.serialize_with_options(serde_json::value::Serializer, &serialize_opts)
        .map_err(|e| (XrayError::BadJson, format!("failed to serialize response to JSON: {e}")))?;

    unpack_typed_messages(pool, &mut res_json_val);

    serde_json::to_string(&res_json_val)
        .map_err(|e| (XrayError::BadJson, format!("failed to stringify response JSON: {e}")))
}
