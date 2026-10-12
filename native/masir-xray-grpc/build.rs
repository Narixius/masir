use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use protox::prost::Message;

fn collect_protos(dir: &Path, protos: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_protos(&path, protos);
            } else if path.extension().is_some_and(|ext| ext == "proto") {
                protos.push(path);
            }
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=proto");

    let proto_dir = Path::new("proto");
    let mut protos = Vec::new();
    collect_protos(proto_dir, &mut protos);

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let descriptor_path = out_dir.join("xray_file_descriptor_set.bin");

    let file_descriptors = protox::compile(&protos, &[proto_dir.to_path_buf()])
        .expect("failed to compile Xray protos with protox");

    fs::write(&descriptor_path, file_descriptors.encode_to_vec())
        .expect("failed to write compiled descriptor set");
}
