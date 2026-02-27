class SettingsRepository {
  constructor(store) {
    this.store = store;
  }

  findByShop(shopDomain) {
    const db = this.store.read();
    return db.settings.find((item) => item.shopDomain === shopDomain) || null;
  }

  upsertByShop(shopDomain, nextValues) {
    const db = this.store.read();
    const index = db.settings.findIndex((item) => item.shopDomain === shopDomain);

    const current =
      index === -1
        ? {
            shopDomain,
            keiAiApiKey: "",
            openAiApiKey: "",
            kieGenerateUrl: "https://api.kie.ai/api/v1/gpt4o-image/generate",
            kieEditUrl: "https://api.kie.ai/api/v1/gpt4o-image/generate",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
        : db.settings[index];

    const merged = {
      ...current,
      ...nextValues,
      shopDomain,
      updatedAt: Date.now(),
    };

    if (index === -1) {
      db.settings.push(merged);
    } else {
      db.settings[index] = merged;
    }

    this.store.write(db);
    return merged;
  }

  deleteByShop(shopDomain) {
    const db = this.store.read();
    const before = db.settings.length;
    db.settings = db.settings.filter((item) => item.shopDomain !== shopDomain);
    this.store.write(db);
    return before - db.settings.length;
  }
}

module.exports = {
  SettingsRepository,
};
