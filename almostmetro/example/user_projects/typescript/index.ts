import { greet } from "./utils";

const name: string = "World";
console.log(greet(name));

const numbers: number[] = [1, 2, 3, 4, 5];
console.log("Doubled:", numbers.map((n: number) => n * 2));
