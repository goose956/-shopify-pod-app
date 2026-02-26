class AssetRepository {
  constructor(store) {
    this.store = store;
  }

  create(asset) {
    const db = this.store.read();
    db.assets.push(asset);
    this.store.write(db);
    return asset;
  }

  listByDesign(designId) {
    const db = this.store.read();
    return db.assets.filter((item) => item.designId === designId);
  }

  findById(assetId) {
    const db = this.store.read();
    return db.assets.find((item) => item.id === assetId) || null;
  }

  deleteByDesign(designId) {
    const db = this.store.read();
    db.assets = db.assets.filter((item) => item.designId !== designId);
    this.store.write(db);
  }
}

module.exports = {
  AssetRepository,
};
