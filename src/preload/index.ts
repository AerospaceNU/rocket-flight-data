import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('appInfo', {
  name: 'Rocket Flight Data',
  version: '0.1.0'
});
