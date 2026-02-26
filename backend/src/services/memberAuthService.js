const { randomBytes, scryptSync, timingSafeEqual } = require("crypto");

class MemberAuthService {
  constructor(memberRepository) {
    this.memberRepository = memberRepository;
  }

  hashPassword(password, salt) {
    return scryptSync(password, salt, 64).toString("hex");
  }

  generateToken() {
    return randomBytes(32).toString("hex");
  }

  extractToken(req) {
    const bearer = String(req.headers.authorization || "");
    if (bearer.startsWith("Bearer member_")) {
      return bearer.slice(7).trim();
    }

    if (bearer.startsWith("Bearer ")) {
      const token = bearer.slice(7).trim();
      if (token.startsWith("member_")) {
        return token;
      }
    }

    const explicit = String(req.headers["x-member-token"] || "").trim();
    if (explicit) {
      return explicit;
    }

    return "";
  }

  maskEmail(email) {
    const safe = String(email || "").trim().toLowerCase();
    const [local, domain] = safe.split("@");
    if (!local || !domain) {
      return "";
    }

    const first = local.slice(0, 1);
    return `${first}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
  }

  sanitizeMember(member) {
    if (!member) {
      return null;
    }

    return {
      id: member.id,
      email: member.email,
      maskedEmail: this.maskEmail(member.email),
      fullName: member.fullName,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
      lastLoginAt: member.lastLoginAt,
    };
  }

  async register({ email, fullName, password }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedName = String(fullName || "").trim();
    const rawPassword = String(password || "");

    if (!normalizedEmail || !rawPassword) {
      throw new Error("Email and password are required");
    }

    if (rawPassword.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }

    const existing = this.memberRepository.findByEmail(normalizedEmail);
    if (existing) {
      throw new Error("Email is already registered");
    }

    const passwordSalt = randomBytes(16).toString("hex");
    const passwordHash = this.hashPassword(rawPassword, passwordSalt);

    const member = this.memberRepository.create({
      email: normalizedEmail,
      fullName: normalizedName || normalizedEmail,
      passwordHash,
      passwordSalt,
    });

    return this.sanitizeMember(member);
  }

  async login({ email, password }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const rawPassword = String(password || "");

    const member = this.memberRepository.findByEmail(normalizedEmail);
    if (!member) {
      throw new Error("Invalid email or password");
    }

    const hashed = this.hashPassword(rawPassword, member.passwordSalt);
    const isValid = timingSafeEqual(Buffer.from(hashed, "hex"), Buffer.from(member.passwordHash, "hex"));
    if (!isValid) {
      throw new Error("Invalid email or password");
    }

    const token = `member_${this.generateToken()}`;
    const updated = this.memberRepository.update(member.id, {
      authToken: token,
      lastLoginAt: Date.now(),
    });

    return {
      token,
      member: this.sanitizeMember(updated),
    };
  }

  async validateRequest(req) {
    const token = this.extractToken(req);
    if (!token) {
      return null;
    }

    const member = this.memberRepository.findByAuthToken(token);
    if (!member) {
      return null;
    }

    return {
      memberId: member.id,
      email: member.email,
      fullName: member.fullName,
      shopDomain: `member:${member.id}`,
      authToken: token,
    };
  }
}

module.exports = {
  MemberAuthService,
};
