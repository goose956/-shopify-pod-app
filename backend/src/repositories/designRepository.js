class DesignRepository {
  constructor(store) {
    this.store = store;
  }

  create(design) {
    const db = this.store.read();
    db.designs.push(design);
    this.store.write(db);
    return design;
  }

  update(designId, updater) {
    const db = this.store.read();
    const index = db.designs.findIndex((item) => item.id === designId);
    if (index === -1) {
      return null;
    }

    const current = db.designs[index];
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    db.designs[index] = next;
    this.store.write(db);
    return next;
  }

  findById(designId) {
    const db = this.store.read();
    return db.designs.find((item) => item.id === designId) || null;
  }

  listByShop(shopDomain) {
    const db = this.store.read();
    return db.designs.filter((item) => item.shopDomain === shopDomain);
  }

  delete(designId) {
    const db = this.store.read();
    const index = db.designs.findIndex((item) => item.id === designId);
    if (index === -1) return false;
    db.designs.splice(index, 1);
    this.store.write(db);
    return true;
  }
}

module.exports = {
  DesignRepository,
};
