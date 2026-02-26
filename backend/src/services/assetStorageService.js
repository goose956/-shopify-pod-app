const { randomUUID } = require("crypto");

class AssetStorageService {
  constructor(assetRepository) {
    this.assetRepository = assetRepository;
  }

  saveAsset({ designId, shopDomain, type, role, url, promptSnapshot }) {
    const asset = {
      id: randomUUID(),
      designId,
      shopDomain,
      type,
      role,
      url,
      promptSnapshot: promptSnapshot || "",
      createdAt: Date.now(),
    };

    this.assetRepository.create(asset);
    return asset;
  }

  listDesignAssets(designId) {
    return this.assetRepository.listByDesign(designId);
  }
}

module.exports = {
  AssetStorageService,
};
