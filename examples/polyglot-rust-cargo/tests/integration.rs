use polyglot_rust_cargo::hello;

#[test]
fn integration_hello() {
    assert_eq!(hello("integration"), "Hello, integration!");
}
