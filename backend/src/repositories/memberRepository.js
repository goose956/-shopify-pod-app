const { randomUUID } = require("crypto");

class MemberRepository {
  constructor(store) {
    this.store = store;
  }

  list() {
    const db = this.store.read();
    return [...db.members].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }

  findById(memberId) {
    const db = this.store.read();
    return db.members.find((item) => item.id === memberId) || null;
  }

  findByEmail(email) {
    const target = String(email || "").trim().toLowerCase();
    if (!target) {
      return null;
    }

    const db = this.store.read();
    return db.members.find((item) => String(item.email || "").toLowerCase() === target) || null;
  }

  create({ email, fullName, passwordHash, passwordSalt }) {
    const db = this.store.read();
    const now = Date.now();

    const member = {
      id: randomUUID(),
      email: String(email || "").trim().toLowerCase(),
      fullName: String(fullName || "").trim(),
      passwordHash,
      passwordSalt,
      authToken: "",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };

    db.members.push(member);
    this.store.write(db);
    return member;
  }

  update(memberId, updater) {
    const db = this.store.read();
    const index = db.members.findIndex((item) => item.id === memberId);
    if (index === -1) {
      return null;
    }

    const current = db.members[index];
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    db.members[index] = {
      ...next,
      updatedAt: Date.now(),
    };
    this.store.write(db);
    return db.members[index];
  }

  findByAuthToken(token) {
    const target = String(token || "").trim();
    if (!target) {
      return null;
    }

    const db = this.store.read();
    return db.members.find((item) => item.authToken === target) || null;
  }
}

module.exports = {
  MemberRepository,
};
