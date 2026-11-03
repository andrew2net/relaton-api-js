export interface Supplement {
  stage?: string;
  word: string;
  number?: string;
  year?: string;
}

export interface Identifier {
  flavor: string;
  publishers: string[];
  stage?: string;
  type?: string;
  number: string;
  part?: string;
  year?: string;
  supplements: Supplement[];
  language?: string;
  allParts?: boolean;
  canonical: string;
  raw: string;
}
