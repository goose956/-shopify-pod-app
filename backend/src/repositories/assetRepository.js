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

  listByDesign(designId, shopDomain) {
    const db = this.store.read();
    const assets = db.assets.filter((item) => item.designId === designId);
    if (shopDomain) return assets.filter((a) => a.shopDomain === shopDomain);
    return assets;
  }

  findById(assetId, shopDomain) {
    const db = this.store.read();
    const asset = db.assets.find((item) => item.id === assetId) || null;
    if (asset && shopDomain && asset.shopDomain !== shopDomain) return null;
    return asset;
  }

  deleteByDesign(designId, shopDomain) {
    const db = this.store.read();
    if (shopDomain) {
      db.assets = db.assets.filter((item) => !(item.designId === designId && item.shopDomain === shopDomain));
    } else {
      db.assets = db.assets.filter((item) => item.designId !== designId);
    }
    this.store.write(db);
  }
}

module.exports = {
  AssetRepository,
};
