class ProductRepository {
  constructor(store) {
    this.store = store;
  }

  upsertByDesign(designId, productRecord) {
    const db = this.store.read();
    const existingIndex = db.products.findIndex((item) => item.designId === designId);
    if (existingIndex === -1) {
      db.products.push(productRecord);
    } else {
      db.products[existingIndex] = productRecord;
    }
    this.store.write(db);
    return productRecord;
  }

  findByDesign(designId) {
    const db = this.store.read();
    return db.products.find((item) => item.designId === designId) || null;
  }

  deleteByDesign(designId) {
    const db = this.store.read();
    db.products = db.products.filter((item) => item.designId !== designId);
    this.store.write(db);
  }
}

module.exports = {
  ProductRepository,
};
