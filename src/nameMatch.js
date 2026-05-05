function normalizeTeamName(value) {
  if (!value) {
    return "";
  }

  const lowered = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const expanded = lowered
    .replace(/\bman\s+city\b/g, "manchester city")
    .replace(/\bman\s+united\b/g, "manchester united")
    .replace(/\bpsg\b/g, "paris saint germain")
    .replace(/\binter\b/g, "internazionale")
    .replace(/\batletico\b/g, "atletico")
    .replace(/\bbayern\b/g, "bayern munich")
    .replace(/\bspurs\b/g, "tottenham hotspur")
    .replace(/\bnewcastle\b/g, "newcastle united")
    .replace(/\bqpr\b/g, "queens park rangers")
    .replace(/\bst\.?\b/g, "saint")
    .replace(/\bathletic\b/g, "athletic")
    .replace(/\bkf\.?\b/g, "kameratene forening")
    .replace(/\bkfum\b/g, "kf um")
    .replace(/\bfc\b/g, "")
    .replace(/\bcf\b/g, "")
    .replace(/\bif\b/g, "")
    .replace(/\bfk\b/g, "")
    .replace(/\bsk\b/g, "")
    .replace(/\bac\b/g, "")
    .replace(/\bthe\b/g, "")
    .replace(/\bclub\b/g, "");

  return expanded
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeTeamName(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(" ")
    .map((x) => x.trim())
    .filter(Boolean);
}

function jaccardSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) {
    return 0;
  }

  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;

  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function teamSimilarity(aName, bName) {
  const aNorm = normalizeTeamName(aName);
  const bNorm = normalizeTeamName(bName);

  if (!aNorm || !bNorm) {
    return 0;
  }

  if (aNorm === bNorm) {
    return 1;
  }

  return jaccardSimilarity(tokenize(aNorm), tokenize(bNorm));
}

function parseMatchTeams(title) {
  if (!title) {
    return null;
  }

  const cleaned = String(title).replace(/\s+/g, " ").trim();
  const separators = [/\s+vs\.?\s+/i, /\s+v\s+/i, /\s+@\s+/i, /\s+-\s+/i];

  for (const separator of separators) {
    const parts = cleaned.split(separator);
    if (parts.length === 2 && parts[0] && parts[1]) {
      return {
        left: parts[0].trim(),
        right: parts[1].trim(),
      };
    }
  }

  return null;
}

module.exports = {
  normalizeTeamName,
  tokenize,
  teamSimilarity,
  parseMatchTeams,
};
