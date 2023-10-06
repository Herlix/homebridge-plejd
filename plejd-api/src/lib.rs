mod utils;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn greet() -> Result<String, JsValue> {
    let resp = reqwest::get("https://httpbin.org/ip")
        .await
        .unwrap()
        .json::<HashMap<String, String>>()
        .await
        .unwrap();

    return Ok(format!("Here we go!! {:#?}", resp));
}
