function indentation(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function meaningfulLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((raw, index) => ({ raw: raw.replace(/\s+$/, ""), line: index + 1 }))
    .filter(({ raw }) => raw.trim() !== "" && !raw.trimStart().startsWith("#"));
}

function parseScalar(source, line) {
  const value = source.trim();
  if (value === "") return "";
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`YAML line ${line}: invalid quoted string (${error.message})`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) {
      throw new Error(`YAML line ${line}: unterminated single-quoted string`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (/^-?(0|[1-9][0-9]*)$/.test(value)) return Number(value);
  if (/^-?(0|[1-9][0-9]*)\.[0-9]+$/.test(value)) return Number(value);
  if (/^[!&*|>]/.test(value)) {
    throw new Error(
      `YAML line ${line}: tags, anchors, aliases, and block scalars are not supported`,
    );
  }
  return value;
}

function parseBlock(lines, start, indent) {
  if (start >= lines.length || indentation(lines[start].raw) < indent) {
    return { value: null, next: start };
  }
  const isArray = lines[start].raw.slice(indent).startsWith("-");
  const value = isArray ? [] : {};
  let index = start;

  while (index < lines.length) {
    const current = lines[index];
    const currentIndent = indentation(current.raw);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      throw new Error(`YAML line ${current.line}: unexpected indentation`);
    }
    const content = current.raw.slice(indent);

    if (isArray) {
      if (!content.startsWith("-")) {
        throw new Error(`YAML line ${current.line}: expected a list item`);
      }
      const remainder = content.slice(1).trimStart();
      if (remainder !== "") {
        value.push(parseScalar(remainder, current.line));
        index += 1;
        continue;
      }
      const nested = parseBlock(lines, index + 1, indent + 2);
      if (nested.next === index + 1) {
        throw new Error(`YAML line ${current.line}: list item cannot be empty`);
      }
      value.push(nested.value);
      index = nested.next;
      continue;
    }

    const separator = content.indexOf(":");
    if (separator <= 0) {
      throw new Error(`YAML line ${current.line}: expected key: value`);
    }
    const key = content.slice(0, separator).trim();
    const remainder = content.slice(separator + 1).trimStart();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`YAML line ${current.line}: unsupported key ${key}`);
    }
    if (Object.hasOwn(value, key)) {
      throw new Error(`YAML line ${current.line}: duplicate key ${key}`);
    }
    if (remainder !== "") {
      value[key] = parseScalar(remainder, current.line);
      index += 1;
      continue;
    }
    const nested = parseBlock(lines, index + 1, indent + 2);
    if (nested.next === index + 1) {
      value[key] = null;
      index += 1;
    } else {
      value[key] = nested.value;
      index = nested.next;
    }
  }
  return { value, next: index };
}

export function parseYaml(text) {
  const lines = meaningfulLines(text);
  if (lines.length === 0) throw new Error("YAML document is empty");
  if (indentation(lines[0].raw) !== 0) {
    throw new Error(`YAML line ${lines[0].line}: document must start at column 1`);
  }
  const parsed = parseBlock(lines, 0, 0);
  if (parsed.next !== lines.length) {
    throw new Error(`YAML line ${lines[parsed.next].line}: could not parse document`);
  }
  return parsed.value;
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  const plainSafe =
    text !== "" &&
    /^[A-Za-z0-9_./ -]+$/.test(text) &&
    !/^\s|\s$/.test(text) &&
    !/^(true|false|null|~|-?[0-9]+(?:\.[0-9]+)?)$/i.test(text) &&
    !text.includes(" #");
  return plainSafe ? text : JSON.stringify(text);
}

function stringifyNode(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item !== null && typeof item === "object"
          ? `${pad}-\n${stringifyNode(item, indent + 2)}`
          : `${pad}- ${scalar(item)}`,
      )
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        if (Array.isArray(item) && item.length === 0) return `${pad}${key}: []`;
        if (
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).length === 0
        ) {
          return `${pad}${key}: {}`;
        }
        return item !== null && typeof item === "object"
          ? `${pad}${key}:\n${stringifyNode(item, indent + 2)}`
          : `${pad}${key}: ${scalar(item)}`;
      })
      .join("\n");
  }
  return `${pad}${scalar(value)}`;
}

export function stringifyYaml(value) {
  if (value === null || typeof value !== "object") {
    throw new Error("YAML document root must be an object or array");
  }
  return `${stringifyNode(value, 0)}\n`;
}
