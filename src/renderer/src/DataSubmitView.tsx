import { useEffect, useMemo, useState } from 'react';
import type { GitDataSubmitPreview, SubmitGitDataResult } from './importTypes';

function defaultCommitMessage() {
  const today = new Date().toISOString().slice(0, 10);
  return `Add flight data ${today}`;
}

function statusLabel(status: string) {
  if (status === '??') return 'new';
  if (status.includes('D')) return 'deleted';
  if (status.includes('M')) return 'modified';
  if (status.includes('A')) return 'added';
  return status || 'changed';
}

export function DataSubmitView() {
  const [preview, setPreview] = useState<GitDataSubmitPreview | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SubmitGitDataResult | null>(null);

  const loadPreview = async () => {
    setIsLoading(true);
    setError('');
    setResult(null);
    try {
      const nextPreview = await window.appBridge.previewGitDataSubmit();
      setPreview(nextPreview);
      setSelectedPaths(nextPreview.changes.map((change) => change.path));
    } catch (loadError) {
      setPreview(null);
      setSelectedPaths([]);
      setError(loadError instanceof Error ? loadError.message : 'Unable to inspect Git changes.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadPreview();
  }, []);

  const selectedCount = selectedPaths.length;
  const canSubmit = selectedCount > 0 && commitMessage.trim() && !isSubmitting;
  const allSelected = useMemo(
    () => preview !== null && preview.changes.length > 0 && selectedPaths.length === preview.changes.length,
    [preview, selectedPaths]
  );

  const togglePath = (path: string) => {
    setSelectedPaths((current) =>
      current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]
    );
  };

  const toggleAll = () => {
    if (!preview) return;
    setSelectedPaths(allSelected ? [] : preview.changes.map((change) => change.path));
  };

  const submit = async () => {
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError('');
    setResult(null);
    try {
      const submitResult = await window.appBridge.submitGitDataChanges({
        selectedPaths,
        commitMessage: commitMessage.trim()
      });
      setResult(submitResult);
      await loadPreview();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to submit data.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="submit-view">
      <section className="panel">
        <div className="panel-header">
          <h2>Submit Data to GitHub</h2>
          <button className="small-button" disabled={isLoading || isSubmitting} onClick={loadPreview} type="button">
            Refresh
          </button>
        </div>

        {preview ? (
          <div className="submit-summary">
            <div>
              <span className="summary-label">Repository</span>
              <span>{preview.repositoryRoot}</span>
            </div>
            <div>
              <span className="summary-label">Branch</span>
              <span>{preview.currentBranch}</span>
            </div>
            <div>
              <span className="summary-label">Remote</span>
              <span>{preview.remoteUrl}</span>
            </div>
            <div>
              <span className="summary-label">Git</span>
              <span>
                {preview.gitVersion}
                {preview.credentialManagerVersion ? ` with ${preview.credentialManagerVersion}` : ''}
              </span>
            </div>
          </div>
        ) : null}

        {preview?.warnings.map((warning) => (
          <div className="warning-text" key={warning}>
            {warning}
          </div>
        ))}
        {error ? <div className="error-text">{error}</div> : null}
        {result ? (
          <div className="success-text">
            Pushed {result.branchName} at {result.commitSha.slice(0, 12)}.
            {result.pullRequestUrl ? ' GitHub opened the pull request page.' : ''}
          </div>
        ) : null}
      </section>

      <section className="panel submit-change-panel">
        <div className="panel-header">
          <h2>Changed Flight Data</h2>
          <span>{preview?.changes.length ?? 0} file(s)</span>
        </div>

        {preview && preview.changes.length > 0 ? (
          <>
            <label className="checkbox-row submit-select-all">
              <input checked={allSelected} onChange={toggleAll} type="checkbox" />
              <span>Select all</span>
            </label>
            <div className="submit-change-list">
              {preview.changes.map((change) => (
                <label className="checkbox-row submit-change-row" key={change.path}>
                  <input
                    checked={selectedPaths.includes(change.path)}
                    onChange={() => togglePath(change.path)}
                    type="checkbox"
                  />
                  <span className="submit-change-path">{change.path}</span>
                  <span className="submit-change-status">{statusLabel(change.status)}</span>
                </label>
              ))}
            </div>
          </>
        ) : (
          <div className="muted-text">
            {isLoading ? 'Checking Git changes...' : 'No changed files under flight-data.'}
          </div>
        )}
      </section>

      <section className="panel">
        <label>
          Commit message
          <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
        </label>
        <footer className="import-actions">
          <span className="muted-text">{selectedCount} selected</span>
          <button className="primary-button" disabled={!canSubmit} onClick={submit} type="button">
            {isSubmitting ? 'Submitting' : 'Create Pull Request'}
          </button>
        </footer>
      </section>
    </section>
  );
}
