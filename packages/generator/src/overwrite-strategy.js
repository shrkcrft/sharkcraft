export var OverwriteStrategy;
(function (OverwriteStrategy) {
    OverwriteStrategy["Never"] = "never";
    OverwriteStrategy["Ask"] = "ask";
    OverwriteStrategy["Overwrite"] = "overwrite";
    OverwriteStrategy["MergeLater"] = "merge-later";
})(OverwriteStrategy || (OverwriteStrategy = {}));
export var NamingStrategy;
(function (NamingStrategy) {
    NamingStrategy["AsIs"] = "as-is";
    NamingStrategy["Kebab"] = "kebab";
    NamingStrategy["Pascal"] = "pascal";
    NamingStrategy["Camel"] = "camel";
    NamingStrategy["Snake"] = "snake";
})(NamingStrategy || (NamingStrategy = {}));
