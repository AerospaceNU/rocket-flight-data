import { contextBridge, ipcRenderer } from 'electron';
import type { ApiSurface, AttributeRow } from '../shared/types';

const api: ApiSurface = {
  listFlights: () => ipcRenderer.invoke('flights:list'),
  listAltimeters: (flightId) => ipcRenderer.invoke('altimeters:list', flightId),
  getAttributes: (flightId, altimeterId) =>
    ipcRenderer.invoke('attributes:get', flightId, altimeterId),
  saveAttributes: (flightId, altimeterId, rows: AttributeRow[]) =>
    ipcRenderer.invoke('attributes:save', flightId, altimeterId, rows),
  getData: (flightId, altimeterId) => ipcRenderer.invoke('data:get', flightId, altimeterId),
};

contextBridge.exposeInMainWorld('api', api);
