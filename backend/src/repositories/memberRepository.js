const { randomUUID } = require("crypto");

class MemberRepository {
  constructor(store) {
    this.store = store;
  }

  list(shopDomain) {
    const db = this.store.read();
    let members = [...db.members];
    if (shopDomain) members = members.filter((m) => m.shopDomain === shopDomain);
    return members.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }

  findById(memberId) {
    const db = this.store.read();
    return db.members.find((item) => item.id === memberId) || null;
  }

  findByEmail(email, shopDomain) {
    const target = String(email || "").trim().toLowerCase();
    if (!target) {
      return null;
    }

    const db = this.store.read();
    return db.members.find((item) => {
      if (String(item.email || "").toLowerCase() !== target) return false;
      if (shopDomain && item.shopDomain && item.shopDomain !== shopDomain) return false;
      return true;
    }) || null;
  }

  create({ email, fullName, passwordHash, passwordSalt, shopDomain }) {
    const db = this.store.read();
    const now = Date.now();

    const member = {
      id: randomUUID(),
      email: String(email || "").trim().toLowerCase(),
      fullName: String(fullName || "").trim(),
      passwordHash,
      passwordSalt,
      shopDomain: shopDomain || null,
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
