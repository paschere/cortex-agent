export interface DriveChangeFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  trashed?: boolean;
  md5Checksum?: string;
}

export interface DriveChange {
  removed?: boolean;
  fileId: string;
  file?: DriveChangeFile;
}

export interface ChangesResponse {
  newStartPageToken?: string;
  nextPageToken?: string;
  changes?: DriveChange[];
}

/** Return a new cursor only after every change in every page has been applied. */
export async function drainDriveChanges(
  startToken: string,
  readPage: (token: string) => Promise<ChangesResponse>,
  apply: (change: DriveChange) => Promise<void>,
  markFailure: (change: DriveChange, error: unknown) => Promise<void>,
): Promise<string> {
  let pageToken = startToken;
  while (pageToken) {
    const page = await readPage(pageToken);
    let failedChanges = 0;
    for (const change of page.changes ?? []) {
      try {
        await apply(change);
      } catch (error) {
        failedChanges += 1;
        await markFailure(change, error);
      }
    }
    if (failedChanges > 0)
      throw new Error(`${failedChanges} cambio(s) de Drive fallaron; se reintentará la página.`);
    if (page.newStartPageToken) return page.newStartPageToken;
    if (!page.nextPageToken) throw new Error('Drive did not return a new changes cursor');
    pageToken = page.nextPageToken;
  }
  throw new Error('Missing Drive changes cursor');
}
