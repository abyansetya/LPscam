const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SQLITE_EXE = process.env.SQLITE_EXE || "sqlite3";

function ensureDatabase(dbPath, schemaPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execSql(dbPath, fs.readFileSync(schemaPath, "utf8"));
}

function execSql(dbPath, sql) {
  execFileSync(SQLITE_EXE, [dbPath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

function runTransaction(dbPath, statements) {
  if (!statements.length) return;
  execSql(dbPath, ["BEGIN IMMEDIATE;", ...statements, "COMMIT;"].join("\n"));
}

function sqlText(value) {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlInteger(value) {
  if (value == null || value === "") return "NULL";
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : "NULL";
}

function sqlReal(value) {
  if (value == null || value === "") return "NULL";
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "NULL";
}

function sqlBoolean(value) {
  if (value == null) return "NULL";
  return value ? "1" : "0";
}

function sqlJson(value) {
  if (value == null) return "NULL";
  return sqlText(JSON.stringify(value));
}

function selectJson(dbPath, sql) {
  const output = execFileSync(SQLITE_EXE, ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  }).trim();
  return output ? JSON.parse(output) : [];
}

module.exports = {
  ensureDatabase,
  runTransaction,
  selectJson,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlReal,
  sqlText,
};
