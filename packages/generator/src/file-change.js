export var FileChangeType;
(function (FileChangeType) {
    FileChangeType["Create"] = "create";
    FileChangeType["Update"] = "update";
    FileChangeType["Skip"] = "skip";
    FileChangeType["Conflict"] = "conflict";
})(FileChangeType || (FileChangeType = {}));
