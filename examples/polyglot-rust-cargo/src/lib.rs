pub fn hello(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_includes_name() {
        assert_eq!(hello("world"), "Hello, world!");
    }
}
