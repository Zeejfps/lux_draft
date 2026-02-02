export interface FormatOptions {
  decimal?: boolean;
}

export function formatImperial(feet: number, options: FormatOptions = {}): string {
  if (options.decimal) {
    return `${feet.toFixed(2)}'`;
  }

  const totalInches = Math.round(feet * 12);
  const wholeFeet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;

  if (inches === 0) {
    return `${wholeFeet}'`;
  }

  return `${wholeFeet}' ${inches}"`;
}

export function parseImperial(input: string): number | null {
  const trimmed = input.trim();

  const decimalMatch = trimmed.match(/^([\d.]+)'?$/);
  if (decimalMatch) {
    const value = parseFloat(decimalMatch[1]);
    return isNaN(value) ? null : value;
  }

  const feetInchesMatch = trimmed.match(/^(\d+)'?\s*(\d+)"?$/);
  if (feetInchesMatch) {
    const feetVal = parseInt(feetInchesMatch[1], 10);
    const inchesVal = parseInt(feetInchesMatch[2], 10);
    return feetVal + inchesVal / 12;
  }

  const feetOnlyMatch = trimmed.match(/^(\d+)'$/);
  if (feetOnlyMatch) {
    return parseInt(feetOnlyMatch[1], 10);
  }

  const inchesOnlyMatch = trimmed.match(/^(\d+)"$/);
  if (inchesOnlyMatch) {
    return parseInt(inchesOnlyMatch[1], 10) / 12;
  }

  return null;
}

export function kelvinToRGB(kelvin: number): { r: number; g: number; b: number } {
  const temp = kelvin / 100;
  let r: number, g: number, b: number;

  if (temp <= 66) {
    r = 255;
    g = Math.max(0, Math.min(255, 99.4708025861 * Math.log(temp) - 161.1195681661));
  } else {
    r = Math.max(0, Math.min(255, 329.698727446 * Math.pow(temp - 60, -0.1332047592)));
    g = Math.max(0, Math.min(255, 288.1221695283 * Math.pow(temp - 60, -0.0755148492)));
  }

  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = Math.max(0, Math.min(255, 138.5177312231 * Math.log(temp - 10) - 305.0447927307));
  }

  return { r: r / 255, g: g / 255, b: b / 255 };
}
