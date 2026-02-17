var _ = require("lodash");
var greet = require("./utils");

console.log(greet("World"));
console.log("Shuffled:", _.shuffle([1, 2, 3, 4, 5]));
