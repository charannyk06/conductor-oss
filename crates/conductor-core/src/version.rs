/// Product version embedded into release binaries.
///
/// Development builds fall back to the Cargo workspace version. Release jobs
/// set `CONDUCTOR_BUILD_VERSION` before compiling so the native binary, HTTP
/// health payload, ACP/MCP servers, and protocol clients all report the same
/// version as the published npm package.
pub const BUILD_VERSION: &str = match option_env!("CONDUCTOR_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_version_is_non_empty_and_semver_shaped() {
        assert!(!BUILD_VERSION.trim().is_empty());
        assert_eq!(BUILD_VERSION.split('.').count(), 3);
    }
}
