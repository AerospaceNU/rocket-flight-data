import type { ColumnUnitMap } from '../../shared/units';

export type ParsedImport = {
  headers: string[];
  rows: string[][];
  columnUnits: ColumnUnitMap;
  attributes: Record<string, string>;
  warnings: string[];
  sourceFiles: string[];
};

export type ParseOptions = {
  sanitize?: boolean;
};

export type ImportPreview = {
  headers: string[];
  columnUnits: ColumnUnitMap;
  rowCount: number;
  attributes: Record<string, string>;
  warnings: string[];
  sourceFiles: string[];
};

export interface AltimeterImporter {
  id: string;
  name: string;
  parse(filePaths: string[], options?: ParseOptions): Promise<ParsedImport>;
}
