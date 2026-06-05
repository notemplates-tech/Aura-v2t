import { getAccessToken } from './auth';

export async function createGoogleDoc(title: string, content: string) {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");

  // Create document
  const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  if (!createRes.ok) throw new Error("Failed to create document");
  const doc = await createRes.json();
  const documentId = doc.documentId;

  // Insert content
  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: content,
          }
        }
      ]
    }),
  });
  
  if (!updateRes.ok) {
    console.error(await updateRes.json());
    throw new Error("Failed to update document content");
  }
  
  return documentId;
}

export async function getOrCreateDriveFolder(folderName: string): Promise<string> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");

  const query = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  if (!searchRes.ok) throw new Error("Failed to search Drive");
  const searchData = await searchRes.json();
  
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }
  
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder"
    })
  });
  
  if (!createRes.ok) throw new Error("Failed to create folder");
  const createData = await createRes.json();
  return createData.id;
}

export async function saveToDrive(content: string, filename: string) {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");

  const folderId = await getOrCreateDriveFolder("Aura Voice AI");

  const metadataRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: `${filename}.txt`,
      parents: [folderId],
      mimeType: "text/plain"
    })
  });

  if (!metadataRes.ok) throw new Error("Failed to create file metadata in Drive");
  const fileData = await metadataRes.json();
  const fileId = fileData.id;

  const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain"
    },
    body: content
  });

  if (!uploadRes.ok) throw new Error("Failed to upload content to Drive file");
  return fileData;
}

export async function uploadBlobToDrive(blob: Blob, filename: string): Promise<string> {
  const token = await getAccessToken();
  if (!token) throw new Error("Пожалуйста, войдите через Google для загрузки больших файлов.");

  const folderId = await getOrCreateDriveFolder("Aura Voice AI Chunks");

  // Create file metadata in Drive
  const metadataRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: filename,
      parents: [folderId],
      mimeType: blob.type || "application/octet-stream"
    })
  });

  if (!metadataRes.ok) {
    const errorText = await metadataRes.text();
    throw new Error(`Не удалось создать метаданные файла в Google Drive: ${errorText}`);
  }
  
  const fileData = await metadataRes.json();
  const fileId = fileData.id;

  // Upload the media content
  const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": blob.type || "application/octet-stream"
    },
    body: blob
  });

  if (!uploadRes.ok) {
    const errorText = await uploadRes.text();
    throw new Error(`Не удалось загрузить данные в Google Drive: ${errorText}`);
  }

  return fileId;
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) return;
  
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  }).catch(err => console.warn("Failed to delete drive file:", fileId, err));
}

export async function createCalendarEvent(summary: string, description: string) {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");

  const start = new Date();
  start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);

  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    }),
  });
  
  if (!res.ok) throw new Error("Failed to create calendar event");
  return await res.json();
}
