from myapp.greet import hello


def test_hello_includes_name():
    assert hello("world") == "Hello, world!"
