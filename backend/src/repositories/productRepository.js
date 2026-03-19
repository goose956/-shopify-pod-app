class ProductRepository {
  constructor(store) {
    this.store = store;
  }

  upsertByDesign(designId, productRecord, shopDomain) {
    const db = this.store.read();
    const existingIndex = db.products.findIndex((item) => item.designId === designId);
    if (existingIndex === -1) {
      db.products.push(productRecord);
    } else {
      if (shopDomain && db.products[existingIndex].shopDomain && db.products[existingIndex].shopDomain !== shopDomain) return null;
      db.products[existingIndex] = productRecord;
    }
    this.store.write(db);
    return productRecord;
  }

  findByDesign(designId, shopDomain) {
    const db = this.store.read();
    const product = db.products.find((item) => item.designId === designId) || null;
    if (product && shopDomain && product.shopDomain && product.shopDomain !== shopDomain) return null;
    return product;
  }

  deleteByDesign(designId, shopDomain) {
    const db = this.store.read();
    if (shopDomain) {
      db.products = db.products.filter((item) => !(item.designId === designId && item.shopDomain === shopDomain));
    } else {
      db.products = db.products.filter((item) => item.designId !== designId);
    }
    this.store.write(db);
  }
}

module.exports = {
  ProductRepository,
};
