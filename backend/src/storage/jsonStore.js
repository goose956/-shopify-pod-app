const fs = require("fs");
const path = require("path");

const INITIAL_STORE = {
  designs: [],
  assets: [],
  products: [],
  settings: [],
  members: [],
};

function ensureStoreFile(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(INITIAL_STORE, null, 2), "utf8");
  }
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    ensureStoreFile(this.filePath);
  }

  read() {
    ensureStoreFile(this.filePath);
    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      designs: Array.isArray(parsed.designs) ? parsed.designs : [],
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      settings: Array.isArray(parsed.settings) ? parsed.settings : [],
      members: Array.isArray(parsed.members) ? parsed.members : [],
    };
  }

  write(nextState) {
    fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2), "utf8");
  }
}

module.exports = {
  JsonStore,
};
