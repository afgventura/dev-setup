export class StrictJsonlDecoder {
  #buffer = Buffer.alloc(0);
  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const records = [];
    while (true) {
      const end = this.#buffer.indexOf(10);
      if (end < 0) break;
      let line = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length) records.push(JSON.parse(line.toString("utf8")));
    }
    return records;
  }
}
