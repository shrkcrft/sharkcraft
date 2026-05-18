using PolyglotCSharp;
using Xunit;

namespace PolyglotCSharp.Tests;

public class GreetTests
{
    [Fact]
    public void HelloIncludesName()
    {
        Assert.Equal("Hello, world!", Greet.Hello("world"));
    }
}
