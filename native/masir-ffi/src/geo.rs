//! xray's geo data for the rule pickers: the categories in `geosite.dat` /
//! `geoip.dat` with counts (and geosite attributes), plus human-readable labels
//! (`category-ir` -> "Iranian Websites" 🇮🇷), ported from masir-v1.
//!
//!   masir_geo_list(path, kind, out)  -> bytes of JSON | -2 error | -3 buffer too small | -4 unreadable file
//!   masir_geo_humanize(code, out)    -> bytes of {"label", "flag"?} JSON | -2 | -3
//!
//! `kind` 0 = geosite, 1 = geoip.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

use prost::Message;
use serde::Serialize;

use crate::prompt::parse_str;

const ERROR: i32 = -2;
const BUFFER_TOO_SMALL: i32 = -3;
const UNREADABLE: i32 = -4;

// Only the fields the pickers need; prost skips the rest (domain values, CIDRs' bytes are still read).
#[derive(Clone, PartialEq, Message)]
struct Attribute {
    #[prost(string, tag = "1")]
    key: String,
}

#[derive(Clone, PartialEq, Message)]
struct Domain {
    #[prost(message, repeated, tag = "3")]
    attribute: Vec<Attribute>,
}

#[derive(Clone, PartialEq, Message)]
struct GeoSite {
    #[prost(string, tag = "1")]
    code: String,
    #[prost(message, repeated, tag = "2")]
    domain: Vec<Domain>,
}

#[derive(Clone, PartialEq, Message)]
struct GeoSiteList {
    #[prost(message, repeated, tag = "1")]
    entry: Vec<GeoSite>,
}

#[derive(Clone, PartialEq, Message)]
struct Cidr {}

#[derive(Clone, PartialEq, Message)]
struct GeoIp {
    #[prost(string, tag = "1")]
    code: String,
    #[prost(message, repeated, tag = "2")]
    cidr: Vec<Cidr>,
}

#[derive(Clone, PartialEq, Message)]
struct GeoIpList {
    #[prost(message, repeated, tag = "1")]
    entry: Vec<GeoIp>,
}

#[derive(Serialize)]
struct AttrInfo {
    key: String,
    count: usize,
}

#[derive(Serialize)]
struct CategoryInfo {
    /// Lowercased, as written in rules (`geosite:<code>`).
    code: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    flag: Option<String>,
    count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attrs: Vec<AttrInfo>,
}

#[derive(Serialize)]
struct Humanized {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    flag: Option<String>,
}

fn list_geosite(bytes: &[u8]) -> Result<Vec<CategoryInfo>, prost::DecodeError> {
    let list = GeoSiteList::decode(bytes)?;
    Ok(list
        .entry
        .into_iter()
        .map(|site| {
            let mut attrs: BTreeMap<String, usize> = BTreeMap::new();
            for domain in &site.domain {
                for attr in &domain.attribute {
                    *attrs.entry(attr.key.to_lowercase()).or_default() += 1;
                }
            }
            let code = site.code.to_lowercase();
            let (label, flag) = humanize_geosite_category(&code);
            CategoryInfo {
                count: site.domain.len(),
                attrs: attrs.into_iter().map(|(key, count)| AttrInfo { key, count }).collect(),
                code,
                label,
                flag,
            }
        })
        .collect())
}

fn list_geoip(bytes: &[u8]) -> Result<Vec<CategoryInfo>, prost::DecodeError> {
    let list = GeoIpList::decode(bytes)?;
    Ok(list
        .entry
        .into_iter()
        .map(|ip| {
            let code = ip.code.to_lowercase();
            let (label, flag) = humanize_geoip_code(&code);
            CategoryInfo { count: ip.cidr.len(), attrs: Vec::new(), code, label, flag }
        })
        .collect())
}

/* -------------------------------------------------------------------------- */
/* Humanizing (ported from masir-v1 crates/masir-core/src/subscriptions/country.rs) */
/* -------------------------------------------------------------------------- */

/// Shorter, familiar names where ISO's are long or formal.
fn friendly_country(code: &str) -> Option<&'static str> {
    Some(match code {
        "GB" => "United Kingdom",
        "US" => "United States",
        "NL" => "Netherlands",
        "RU" => "Russia",
        "KR" => "South Korea",
        "KP" => "North Korea",
        "TW" => "Taiwan",
        "HK" => "Hong Kong",
        "MO" => "Macau",
        "IR" => "Iran",
        "SY" => "Syria",
        "AE" => "United Arab Emirates",
        "CZ" => "Czech Republic",
        "CD" => "DR Congo",
        "CG" => "Congo",
        "TZ" => "Tanzania",
        "VN" => "Vietnam",
        "LA" => "Laos",
        "BO" => "Bolivia",
        "VE" => "Venezuela",
        "BN" => "Brunei",
        "FM" => "Micronesia",
        "MD" => "Moldova",
        "PS" => "Palestine",
        "MK" => "North Macedonia",
        "VA" => "Vatican City",
        _ => return None,
    })
}

/// Country name for a 2-letter code. "AI" is skipped: in geosite it means AI, not Anguilla.
pub fn resolve_country_code(code: &str) -> Option<String> {
    let upper = code.to_ascii_uppercase();
    if upper.len() != 2 || upper == "AI" {
        return None;
    }
    if upper == "UK" {
        return Some("UK".to_owned());
    }
    if let Some(name) = friendly_country(&upper) {
        return Some(name.to_owned());
    }
    celes::Country::from_alpha2(&upper).ok().map(|c| {
        let name = c.long_name;
        name.strip_prefix("The ").unwrap_or(name).to_owned()
    })
}

/// "IR" -> 🇮🇷 (UK maps to the GB flag).
pub fn country_code_to_flag(code: &str) -> Option<String> {
    if code.len() != 2 {
        return None;
    }
    let upper = code.to_ascii_uppercase();
    let mut chars = upper.chars();
    let (c1, c2) = (chars.next()?, chars.next()?);
    if !c1.is_ascii_alphabetic() || !c2.is_ascii_alphabetic() {
        return None;
    }
    let (c1, c2) = if upper == "UK" { ('G', 'B') } else { (c1, c2) };
    let r1 = char::from_u32(0x1F1E6 + (c1 as u32 - 'A' as u32))?;
    let r2 = char::from_u32(0x1F1E6 + (c2 as u32 - 'A' as u32))?;
    Some(format!("{r1}{r2}"))
}

fn format_geosite_token(token: &str) -> String {
    match token.to_ascii_lowercase().as_str() {
        "ai" => "AI".to_owned(),
        "tld" => "TLD".to_owned(),
        "id" => "ID".to_owned(),
        "ip" => "IP".to_owned(),
        "vpn" => "VPN".to_owned(),
        "dns" => "DNS".to_owned(),
        "p2p" => "P2P".to_owned(),
        "pt" => "PT".to_owned(),
        "tv" => "TV".to_owned(),
        "os" => "OS".to_owned(),
        "ui" => "UI".to_owned(),
        "api" => "API".to_owned(),
        "url" => "URL".to_owned(),
        "ssl" => "SSL".to_owned(),
        "cdn" => "CDN".to_owned(),
        "isp" => "ISP".to_owned(),
        "tor" => "Tor".to_owned(),
        s => {
            let mut chars = s.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        }
    }
}

fn format_geosite_words(phrase: &str) -> String {
    phrase.split(['-', '_']).filter(|t| !t.is_empty()).map(format_geosite_token).collect::<Vec<_>>().join(" ")
}

fn country_websites(code: &str, country: &str) -> String {
    if code.eq_ignore_ascii_case("ir") { "Iranian Websites".to_owned() } else { format!("{country} Websites") }
}

/// `category-ir` -> ("Iranian Websites", 🇮🇷); `category-ai-!cn` -> ("AI (not China)", none).
pub fn humanize_geosite_category(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    let without_prefix = raw.strip_prefix("geosite:").unwrap_or(raw);
    // An attribute (`google@cn`) is described separately by the caller.
    let without_attr = without_prefix.split('@').next().unwrap_or(without_prefix);
    let s = without_attr.strip_prefix("category-").unwrap_or(without_attr);

    if s.len() == 2 && s.chars().all(|c| c.is_ascii_alphabetic()) {
        if let Some(country) = resolve_country_code(s) {
            return (country_websites(s, &country), country_code_to_flag(s));
        }
    }
    if let Some(pos) = s.rfind("-!") {
        let suffix = &s[pos + 2..];
        if suffix.len() == 2 && suffix.chars().all(|c| c.is_ascii_alphabetic()) {
            if let Some(country) = resolve_country_code(suffix) {
                let prefix = &s[..pos];
                let label = if prefix.is_empty() { format!("Not {country}") } else { format!("{} (not {country})", format_geosite_words(prefix)) };
                return (label, None);
            }
        }
    }
    if let Some(pos) = s.rfind('-') {
        let suffix = &s[pos + 1..];
        if suffix.len() == 2 && suffix.chars().all(|c| c.is_ascii_alphabetic()) {
            if let Some(country) = resolve_country_code(suffix) {
                let prefix = &s[..pos];
                let flag = country_code_to_flag(suffix);
                let label =
                    if prefix.is_empty() { country_websites(suffix, &country) } else { format!("{} ({country})", format_geosite_words(prefix)) };
                return (label, flag);
            }
        }
    }
    (format_geosite_words(s), None)
}

/// `ir` -> ("Iran", 🇮🇷); `private` -> "Private networks (LAN)"; `!cn` -> "Not China".
pub fn humanize_geoip_code(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    let s = raw.strip_prefix("geoip:").unwrap_or(raw).to_lowercase();
    if s == "private" {
        return ("Private networks (LAN)".to_owned(), None);
    }
    if let Some(negated) = s.strip_prefix('!') {
        let (label, _) = humanize_geoip_code(negated);
        return (format!("Not {label}"), None);
    }
    if s.len() == 2 && s.chars().all(|c| c.is_ascii_alphabetic()) {
        if let Some(country) = resolve_country_code(&s) {
            return (country, country_code_to_flag(&s));
        }
    }
    (format_geosite_words(&s), None)
}

/* -------------------------------------------------------------------------- */
/* FFI                                                                        */
/* -------------------------------------------------------------------------- */

fn write_json(json: &str, out: *mut u8, out_len: usize) -> i32 {
    if out.is_null() || json.len() > out_len {
        return BUFFER_TOO_SMALL;
    }
    let dest = unsafe { slice::from_raw_parts_mut(out, out_len) };
    dest[..json.len()].copy_from_slice(json.as_bytes());
    json.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn masir_geo_list(path: *const u8, path_len: usize, kind: u32, out: *mut u8, out_len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(path) = parse_str(path, path_len) else {
            return ERROR;
        };
        let Ok(bytes) = std::fs::read(path) else {
            return UNREADABLE;
        };
        let listed = if kind == 0 { list_geosite(&bytes) } else { list_geoip(&bytes) };
        let Ok(categories) = listed else {
            return ERROR;
        };
        match serde_json::to_string(&categories) {
            Ok(json) => write_json(&json, out, out_len),
            Err(_) => ERROR,
        }
    }))
    .unwrap_or(ERROR)
}

/// `geosite:...` / `geoip:...` / bare geosite code -> {"label", "flag"?}.
#[unsafe(no_mangle)]
pub extern "C" fn masir_geo_humanize(code: *const u8, code_len: usize, out: *mut u8, out_len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(code) = parse_str(code, code_len) else {
            return ERROR;
        };
        let (label, flag) = if code.starts_with("geoip:") { humanize_geoip_code(code) } else { humanize_geosite_category(code) };
        match serde_json::to_string(&Humanized { label, flag }) {
            Ok(json) => write_json(&json, out, out_len),
            Err(_) => ERROR,
        }
    }))
    .unwrap_or(ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(raw: &str) -> (String, Option<String>) {
        humanize_geosite_category(raw)
    }

    #[test]
    fn humanizes_like_masir_v1() {
        assert_eq!(h("category-ir"), ("Iranian Websites".into(), Some("🇮🇷".into())));
        assert_eq!(h("category-ai-cn"), ("AI (China)".into(), Some("🇨🇳".into())));
        assert_eq!(h("category-ai-!cn"), ("AI (not China)".into(), None));
        assert_eq!(h("category-ai-chat-!cn"), ("AI Chat (not China)".into(), None));
        assert_eq!(h("category-scholar-hk"), ("Scholar (Hong Kong)".into(), Some("🇭🇰".into())));
        assert_eq!(h("category-bank-mm"), ("Bank (Myanmar)".into(), Some("🇲🇲".into())));
        assert_eq!(h("category-tld-uk"), ("TLD (UK)".into(), Some("🇬🇧".into())));
        assert_eq!(h("group-ib"), ("Group Ib".into(), None));
        assert_eq!(h("suruga-ya"), ("Suruga Ya".into(), None));
        assert_eq!(h("jetbrains-ai"), ("Jetbrains AI".into(), None));
        assert_eq!(h("ir"), ("Iranian Websites".into(), Some("🇮🇷".into())));
        assert_eq!(h("geosite:category-ir"), ("Iranian Websites".into(), Some("🇮🇷".into())));
        assert_eq!(h("geosite:google@cn"), ("Google".into(), None));
    }

    #[test]
    fn humanizes_geoip_codes() {
        assert_eq!(humanize_geoip_code("geoip:ir"), ("Iran".into(), Some("🇮🇷".into())));
        assert_eq!(humanize_geoip_code("private"), ("Private networks (LAN)".into(), None));
        assert_eq!(humanize_geoip_code("geoip:!cn"), ("Not China".into(), None));
        assert_eq!(humanize_geoip_code("telegram"), ("Telegram".into(), None));
    }

    #[test]
    fn lists_categories_from_encoded_files() {
        let site = GeoSiteList {
            entry: vec![GeoSite {
                code: "GOOGLE".into(),
                domain: vec![
                    Domain { attribute: vec![Attribute { key: "cn".into() }] },
                    Domain { attribute: vec![] },
                ],
            }],
        };
        let listed = list_geosite(&site.encode_to_vec()).unwrap();
        assert_eq!(listed[0].code, "google");
        assert_eq!(listed[0].count, 2);
        assert_eq!(listed[0].attrs[0].key, "cn");

        let ip = GeoIpList { entry: vec![GeoIp { code: "IR".into(), cidr: vec![Cidr {}, Cidr {}, Cidr {}] }] };
        let listed = list_geoip(&ip.encode_to_vec()).unwrap();
        assert_eq!((listed[0].code.as_str(), listed[0].count, listed[0].label.as_str()), ("ir", 3, "Iran"));
    }
}

#[cfg(test)]
mod real_files {
    use super::*;

    /// `MASIR_GEO_DIR=/path/with/dat/files cargo test -p masir-ffi real_files -- --ignored --nocapture`
    #[test]
    #[ignore = "needs real geosite.dat / geoip.dat (MASIR_GEO_DIR)"]
    fn decodes_real_files() {
        let dir = std::env::var("MASIR_GEO_DIR").expect("MASIR_GEO_DIR");
        let started = std::time::Instant::now();
        let sites = list_geosite(&std::fs::read(format!("{dir}/geosite.dat")).unwrap()).unwrap();
        let ips = list_geoip(&std::fs::read(format!("{dir}/geoip.dat")).unwrap()).unwrap();
        println!("{} geosite, {} geoip categories in {:?}", sites.len(), ips.len(), started.elapsed());
        for code in ["category-ir", "category-ai-!cn", "google", "category-ads-all"] {
            if let Some(c) = sites.iter().find(|c| c.code == code) {
                println!("  geosite:{code} -> {} {} · {} domains · attrs {:?}", c.flag.clone().unwrap_or_default(), c.label, c.count, c.attrs.iter().map(|a| &a.key).collect::<Vec<_>>());
            }
        }
        for code in ["ir", "private", "telegram"] {
            if let Some(c) = ips.iter().find(|c| c.code == code) {
                println!("  geoip:{code} -> {} {} · {} ranges", c.flag.clone().unwrap_or_default(), c.label, c.count);
            }
        }
    }
}
