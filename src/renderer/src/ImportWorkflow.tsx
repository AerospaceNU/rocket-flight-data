import { useEffect, useMemo, useState } from 'react';
import { AttributeEditor, ensureRequiredAttributes, hasRequiredAttributes } from './AttributeEditor';
import type {
  CustomAttribute,
  FlightSummary,
  ImportConfig,
  ImportPreview,
  SaveImportRequest,
  SaveImportResult
} from './importTypes';

const REQUIRED_ATTRIBUTE_KEYS = ['motor'];
const MULTILINE_ATTRIBUTE_KEYS = ['flight_notes'];
const ENSURED_ATTRIBUTE_KEYS = [...REQUIRED_ATTRIBUTE_KEYS, ...MULTILINE_ATTRIBUTE_KEYS];

type ImportWorkflowProps = {
  files: string[];
  outputDirectory: string;
  config: ImportConfig | null;
  flights: FlightSummary[];
  onSaved: (result: SaveImportResult) => Promise<void>;
};

function todayString() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function fileName(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function ImportWorkflow({
  files,
  outputDirectory,
  config,
  flights,
  onSaved
}: ImportWorkflowProps) {
  const [altimeterId, setAltimeterId] = useState('');
  const [flightMode, setFlightMode] = useState<'new' | 'existing'>('new');
  const [existingFlightDirectoryName, setExistingFlightDirectoryName] = useState('');
  const [flightDate, setFlightDate] = useState(todayString());
  const [flightName, setFlightName] = useState('');
  const [flightLocation, setFlightLocation] = useState('');
  const [altimeterNote, setAltimeterNote] = useState('');
  const [detectedAltimeterMessage, setDetectedAltimeterMessage] = useState('');
  const [hasAppliedDetection, setHasAppliedDetection] = useState(false);
  const [autoAttributeSourceKey, setAutoAttributeSourceKey] = useState('');
  const [customAttributes, setCustomAttributes] = useState<CustomAttribute[]>(() =>
    ensureRequiredAttributes([], ENSURED_ATTRIBUTE_KEYS)
  );
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveResult, setSaveResult] = useState<SaveImportResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const selectedExistingFlight = useMemo(
    () => flights.find((flight) => flight.directoryName === existingFlightDirectoryName),
    [existingFlightDirectoryName, flights]
  );
  const selectedAltimeter = useMemo(
    () => config?.altimeters.find((altimeter) => altimeter.id === altimeterId),
    [altimeterId, config]
  );

  useEffect(() => {
    if (!altimeterId && config?.altimeters[0]) {
      setAltimeterId(config.altimeters[0].id);
    }
  }, [altimeterId, config]);

  useEffect(() => {
    if (files.length === 0 || hasAppliedDetection) {
      return;
    }

    let ignore = false;

    window.appBridge.detectAltimeter(files).then((result) => {
      if (ignore) return;

      if (result.altimeterId) {
        setAltimeterId(result.altimeterId);
        setDetectedAltimeterMessage(`Detected ${result.altimeterId}: ${result.reason}`);
      } else {
        setDetectedAltimeterMessage(result.reason);
      }

      setHasAppliedDetection(true);
    });

    return () => {
      ignore = true;
    };
  }, [files, hasAppliedDetection]);

  useEffect(() => {
    if (flights.length === 0 && flightMode === 'existing') {
      setFlightMode('new');
    }

    if (!existingFlightDirectoryName && flights[0]) {
      setExistingFlightDirectoryName(flights[0].directoryName);
    }
  }, [existingFlightDirectoryName, flightMode, flights]);

  useEffect(() => {
    if (flightMode === 'existing') {
      setFlightLocation(selectedExistingFlight?.location ?? '');
    }
  }, [flightMode, selectedExistingFlight]);

  useEffect(() => {
    if (!altimeterId || files.length === 0) {
      return;
    }

    let ignore = false;
    setIsPreviewLoading(true);
    setPreviewError('');

    const sourceKey = `${altimeterId}:${files.join('|')}`;

    window.appBridge
      .previewImport({ altimeterId, filePaths: files })
      .then((result) => {
        if (!ignore) {
          setPreview(result);
          if (autoAttributeSourceKey !== sourceKey) {
            const detected = Object.entries(result.attributes).map(([key, value]) => ({ key, value }));
            setCustomAttributes(ensureRequiredAttributes(detected, ENSURED_ATTRIBUTE_KEYS));
            setAutoAttributeSourceKey(sourceKey);
          }
        }
      })
      .catch((error: Error) => {
        if (!ignore) {
          setPreview(null);
          setPreviewError(error.message);
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsPreviewLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [altimeterId, autoAttributeSourceKey, files]);

  const canSave =
    Boolean(altimeterId) &&
    Boolean(preview?.rowCount) &&
    Boolean(flightLocation.trim()) &&
    hasRequiredAttributes(customAttributes, REQUIRED_ATTRIBUTE_KEYS) &&
    (flightMode === 'existing'
      ? Boolean(existingFlightDirectoryName)
      : Boolean(flightDate.trim()) && Boolean(flightName.trim()));

  const save = async () => {
    if (!canSave) {
      return;
    }

    const request: SaveImportRequest = {
      altimeterId,
      filePaths: files,
      flightMode,
      existingFlightDirectoryName:
        flightMode === 'existing' ? existingFlightDirectoryName : undefined,
      newFlight:
        flightMode === 'new'
          ? {
              date: flightDate.trim(),
              name: flightName.trim(),
              location: flightLocation.trim()
            }
          : undefined,
      flightLocation: flightLocation.trim(),
      altimeterNote: altimeterNote.trim(),
      customAttributes: customAttributes.filter((attribute) => attribute.key.trim())
    };

    setIsSaving(true);
    setSaveError('');
    setSaveResult(null);

    try {
      const result = await window.appBridge.saveImport(request);
      setSaveResult(result);
      await onSaved(result);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="import-workflow">
      <section className="panel">
        <div className="panel-header">
          <h2>Import</h2>
          <span>{outputDirectory}</span>
        </div>

        <div className="form-grid">
          <label>
            Altimeter
            <select value={altimeterId} onChange={(event) => setAltimeterId(event.target.value)}>
              {config?.altimeters.map((altimeter) => (
                <option key={altimeter.id} value={altimeter.id}>
                  {altimeter.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Altimeter note
            <input
              value={altimeterNote}
              onChange={(event) => setAltimeterNote(event.target.value)}
              placeholder="Booster, sustainer, payload bay"
            />
          </label>
        </div>
        {detectedAltimeterMessage ? (
          <div className="muted-text">{detectedAltimeterMessage}</div>
        ) : null}

        <div className="section-title">Flight</div>
        <div className="segmented-control">
          <button
            className={flightMode === 'new' ? 'selected' : ''}
            onClick={() => setFlightMode('new')}
            type="button"
          >
            New
          </button>
          <button
            className={flightMode === 'existing' ? 'selected' : ''}
            disabled={flights.length === 0}
            onClick={() => setFlightMode('existing')}
            type="button"
          >
            Existing
          </button>
        </div>

        {flightMode === 'existing' ? (
          <div className="form-grid">
            <label>
              Existing flight
              <select
                value={existingFlightDirectoryName}
                onChange={(event) => setExistingFlightDirectoryName(event.target.value)}
              >
                {flights.map((flight) => (
                  <option key={flight.directoryName} value={flight.directoryName}>
                    {flight.directoryName} ({flight.altimeterCount})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Flight location
              <input
                value={flightLocation}
                onChange={(event) => setFlightLocation(event.target.value)}
              />
            </label>
          </div>
        ) : (
          <div className="form-grid three-column">
            <label>
              Flight date
              <input
                type="date"
                value={flightDate}
                onChange={(event) => setFlightDate(event.target.value)}
              />
            </label>
            <label>
              Flight name
              <input
                value={flightName}
                onChange={(event) => setFlightName(event.target.value)}
                placeholder="Flight name"
              />
            </label>
            <label>
              Flight location
              <input
                value={flightLocation}
                onChange={(event) => setFlightLocation(event.target.value)}
                placeholder="Launch site"
              />
            </label>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Selected Files</h2>
          <span>{files.length} file(s)</span>
        </div>
        <ul className="file-list">
          {files.map((file) => (
            <li key={file} title={file}>
              {fileName(file)}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Attributes</h2>
          <span>{isPreviewLoading ? 'Parsing' : `${preview?.rowCount ?? 0} rows parsed`}</span>
        </div>

        {previewError ? <div className="error-text">{previewError}</div> : null}
        {preview?.warnings.map((warning) => (
          <div className="warning-text" key={warning}>
            {warning}
          </div>
        ))}

        <div className="attribute-group">
          <div className="section-title">Standard</div>
          <div className="attribute-editor">
            <div className="custom-attribute-row">
              <input disabled value="altimeter_name" />
              <input disabled value={selectedAltimeter?.name ?? ''} />
              <span />
            </div>
            <div className="custom-attribute-row">
              <input disabled value="flight_location" />
              <input
                value={flightLocation}
                onChange={(event) => setFlightLocation(event.target.value)}
              />
              <span />
            </div>
            <div className="custom-attribute-row">
              <input disabled value="flight_date" />
              <input
                disabled={flightMode === 'existing'}
                value={flightMode === 'new' ? flightDate : selectedExistingFlight?.date ?? ''}
                onChange={(event) => setFlightDate(event.target.value)}
              />
              <span />
            </div>
            <div className="custom-attribute-row">
              <input disabled value="flight_name" />
              <input
                disabled={flightMode === 'existing'}
                value={flightMode === 'new' ? flightName : selectedExistingFlight?.name ?? ''}
                onChange={(event) => setFlightName(event.target.value)}
              />
              <span />
            </div>
            <div className="custom-attribute-row">
              <input disabled value="altimeter_note" />
              <input
                value={altimeterNote}
                onChange={(event) => setAltimeterNote(event.target.value)}
              />
              <span />
            </div>
          </div>
        </div>

        <div className="attribute-group">
          <div className="section-title">Additional</div>
          <AttributeEditor
            attributes={customAttributes}
            emptyText="No additional attributes."
            onChange={(next) => setCustomAttributes(ensureRequiredAttributes(next, ENSURED_ATTRIBUTE_KEYS))}
            requiredKeys={REQUIRED_ATTRIBUTE_KEYS}
            multilineKeys={MULTILINE_ATTRIBUTE_KEYS}
          />
        </div>
      </section>

      <footer className="import-actions">
        {saveResult ? (
          <div className="success-text">
            Saved {saveResult.rowsWritten} rows to {saveResult.altimeterDirectory}
          </div>
        ) : null}
        {saveError ? <div className="error-text">{saveError}</div> : null}
        <button className="primary-button" disabled={!canSave || isSaving} onClick={save} type="button">
          {isSaving ? 'Saving' : 'Save Import'}
        </button>
      </footer>
    </div>
  );
}
