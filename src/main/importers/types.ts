export type ParsedImport = {
  headers: string[];
  rows: string[][];
  attributes: Record<string, string>;
  warnings: string[];
  sourceFiles: string[];
};

export type ImportPreview = {
  headers: string[];
  rowCount: number;
  attributes: Record<string, string>;
  warnings: string[];
  sourceFiles: string[];
};

export interface AltimeterImporter {
  id: string;
  name: string;
  parse(filePaths: string[]): Promise<ParsedImport>;
}
