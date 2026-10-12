//! Umbrella staticlib re-exporting FFI symbols from `masir-transport` and `masir-xray-grpc`.

pub use masir_transport::ffi::*;
pub use masir_xray_grpc::ffi::*;

pub mod prompt;
pub use prompt::*;

pub mod live_select;
pub use live_select::*;

pub mod bidi;
pub use bidi::masir_text_visual;

pub mod processes;
pub use processes::masir_list_processes;

pub mod geo;
pub use geo::{masir_geo_humanize, masir_geo_list};

