from greet import hello


def test_hello_includes_name():
    assert hello("mixed") == "Hello, mixed!"
