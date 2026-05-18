package com.example;

import java.util.Objects;

public final class Greet {
  private Greet() {}

  public static String hello(String name) {
    Objects.requireNonNull(name, "name");
    return "Hello, " + name + "!";
  }
}
