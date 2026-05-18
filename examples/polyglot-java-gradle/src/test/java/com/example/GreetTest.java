package com.example;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class GreetTest {
  @Test
  void helloIncludesName() {
    assertEquals("Hello, world!", Greet.hello("world"));
  }
}
