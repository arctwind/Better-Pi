import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (command.type === "exit") { process.exit(7); }
    if (command.type === "ignore") continue;
    if (command.type === "fail") {
      console.log(JSON.stringify({ type: "response", id: command.id, success: false, error: "rejected" }));
      continue;
    }
    const record = Buffer.from(`${JSON.stringify({ type: "response", id: command.id, success: true, data: command.value })}\r\n`);
    const midpoint = Math.floor(record.length / 2);
    process.stdout.write(record.subarray(0, midpoint));
    process.stdout.write(record.subarray(midpoint));
  }
});
process.stdin.on("end", () => process.exit(0));
