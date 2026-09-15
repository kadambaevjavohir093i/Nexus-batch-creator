import React, { useState, useEffect } from "react";
import { 
  Cloud, 
  FolderOpen, 
  Search, 
  LogOut, 
  Loader2, 
  FileText, 
  RefreshCw, 
  DownloadCloud,
  CheckCircle,
  Truck,
  AlertTriangle
} from "lucide-react";
import { googleSignIn, logout, getAccessToken, initAuth, isDriveConfigured } from "../lib/firebase";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

interface DriveBrowserProps {
  onFileImported: (file: File) => void;
}

export default function DriveBrowser({ onFileImported }: DriveBrowserProps) {
  const [user, setUser] = useState<any | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());

  // Initialize Firebase Auth listener to pick up active sessions
  useEffect(() => {
    const unsubscribe = initAuth(
      (currentUser, activeToken) => {
        setUser(currentUser);
        setToken(activeToken);
        setLoadingUser(false);
      },
      () => {
        setUser(null);
        setToken(null);
        setLoadingUser(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setLoadingUser(true);
    setErrorCode(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setToken(result.accessToken);
      }
    } catch (err: any) {
      console.error("Sign-in failed:", err);
      setErrorCode(err.message || "Sign-in authentication failed. Please try again.");
    } finally {
      setLoadingUser(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setUser(null);
      setToken(null);
      setFiles([]);
    } catch (err: any) {
      console.error("Logout failed:", err);
    }
  };

  const fetchDriveFiles = async () => {
    if (!token) return;
    setLoadingFiles(true);
    setErrorCode(null);
    try {
      // Build search query: exclusively list PDF files
      let q = "mimeType = 'application/pdf' and trashed = false";
      if (searchQuery.trim()) {
        const escapedQuery = searchQuery.replace(/'/g, "\\'");
        q += ` and name contains '${escapedQuery}'`;
      }

      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        q
      )}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=30&orderBy=modifiedTime desc`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || `HTTP error ${response.status}`);
      }

      const data = await response.json();
      setFiles(data.files || []);
    } catch (err: any) {
      console.error("Failed to query Google Drive files:", err);
      setErrorCode(err.message || "Failed to list PDF files from Google Drive.");
    } finally {
      setLoadingFiles(false);
    }
  };

  // Automatically refresh files list when token changes or search query triggers
  useEffect(() => {
    if (token) {
      fetchDriveFiles();
    }
  }, [token]);

  const handleSearchKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      fetchDriveFiles();
    }
  };

  // Download PDF file from Drive and hand it off as a standard JS File object
  const handleImportFile = async (driveFile: DriveFile) => {
    if (!token) return;
    setImportingId(driveFile.id);
    setErrorCode(null);

    try {
      const url = `https://www.googleapis.com/drive/v3/files/${driveFile.id}?alt=media`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Cloud download failed. Status code: ${response.status}`);
      }

      const blob = await response.blob();
      const fileObj = new File([blob], driveFile.name, { type: "application/pdf" });
      
      // Send up to the parent application queue
      onFileImported(fileObj);
      
      setImportedIds(prev => {
        const next = new Set(prev);
        next.add(driveFile.id);
        return next;
      });
    } catch (err: any) {
      console.error("Failed to fetch binary resource:", err);
      setErrorCode(err.message || "Failed to download and import Google Drive asset.");
    } finally {
      setImportingId(null);
    }
  };

  const formatBytes = (bytesStr?: string) => {
    if (!bytesStr) return "Unknown size";
    const bytes = parseInt(bytesStr, 10);
    if (isNaN(bytes)) return "Unknown size";
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatModifiedTime = (timeStr?: string) => {
    if (!timeStr) return "";
    try {
      const date = new Date(timeStr);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return timeStr;
    }
  };

  if (!isDriveConfigured) {
    return (
      <div className="bg-slate-900/60 rounded-xl p-5 border border-white/5 shadow-xl select-none">
        <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest block mb-2 flex items-center gap-1.5 font-mono">
          <Cloud className="w-4 h-4" />
          <span>Google Drive Connection</span>
        </span>
        <p className="text-[11px] text-slate-400 leading-normal font-sans mb-3">
          Drive import is optional and currently switched off. Add your{" "}
          <span className="text-white px-1 bg-white/5 rounded font-mono">VITE_FIREBASE_*</span>{" "}
          values to <span className="text-white px-1 bg-white/5 rounded font-mono">.env</span> and
          restart the dev server to browse invoices straight from Drive.
        </p>
        <div className="text-[10px] flex items-start gap-1.5 font-mono p-2.5 rounded bg-indigo-950/20 border border-indigo-900/30 text-slate-400 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-400" />
          <span>Local PDF upload works without any of this - use the Local tab.</span>
        </div>
      </div>
    );
  }

  if (loadingUser) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-slate-900/40 rounded-xl border border-white/5 shadow-xl min-h-[220px]">
        <Loader2 className="w-8 h-8 text-indigo-400 animate-spin mb-3 animate-duration-1000" />
        <p className="text-xs text-slate-400 font-mono">Securing Google Workspace tunnel...</p>
      </div>
    );
  }

  if (!user || !token) {
    return (
      <div className="bg-slate-900/60 rounded-xl p-5 border border-white/5 shadow-xl select-none">
        <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest block mb-2 flex items-center gap-1.5 font-mono">
          <Cloud className="w-4 h-4" />
          <span>Google Drive Connection</span>
        </span>
        <p className="text-[11px] text-slate-400 leading-normal font-sans mb-4">
          Connect your authorized Google Drive profile to browse, search, and import truck repair PDF invoices directly from folders.
        </p>
        
        {errorCode && (
          <div className="text-[10px] flex items-start gap-1.5 font-mono p-2.5 rounded bg-rose-950/20 border border-rose-950/40 text-rose-400 mb-3 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{errorCode}</span>
          </div>
        )}

        <button
          onClick={handleLogin}
          type="button"
          className="gsi-material-button w-full cursor-pointer overflow-hidden rounded-lg shadow-md transition-shadow hover:shadow-lg focus:outline-none"
        >
          <div className="gsi-material-button-state"></div>
          <div className="gsi-material-button-content-wrapper">
            <div className="gsi-material-button-icon">
              <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: "block" }}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
              </svg>
            </div>
            <span className="gsi-material-button-contents">Sign in with Google</span>
          </div>
        </button>

        {/* Global style injection for materialistic login button */}
        <style dangerouslySetInnerHTML={{ __html: `
          .gsi-material-button {
            -moz-user-select: none;
            -webkit-user-select: none;
            -ms-user-select: none;
            -webkit-appearance: none;
            background-color: #ffffff;
            background-image: none;
            border: 1px solid #747775;
            -webkit-border-radius: 8px;
            border-radius: 8px;
            -webkit-box-sizing: border-box;
            box-sizing: border-box;
            color: #1f1f1f;
            cursor: pointer;
            font-family: 'Roboto', arial, sans-serif;
            font-size: 13px;
            font-weight: 500;
            height: 40px;
            letter-spacing: 0.25px;
            outline: none;
            padding: 0 12px;
            position: relative;
            text-align: center;
            transition: background-color .218s, border-color .218s, box-shadow .218s;
            transition-property: background-color, border-color, box-shadow;
            vertical-align: middle;
            white-space: nowrap;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .gsi-material-button .gsi-material-button-icon {
            height: 18px;
            margin-right: 12px;
            min-width: 18px;
            width: 18px;
          }
          .gsi-material-button .gsi-material-button-content-wrapper {
            align-items: center;
            display: flex;
            flex-direction: row;
            flex-wrap: nowrap;
            height: 100%;
            justify-content: center;
            position: relative;
            width: 100%;
          }
          .gsi-material-button .gsi-material-button-contents {
            flex-grow: 1;
            font-family: "Inter", sans-serif;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            text-align: center;
          }
          .gsi-material-button .gsi-material-button-state {
            -webkit-border-radius: 4px;
            border-radius: 4px;
            bottom: 0;
            left: 0;
            opacity: 0;
            position: absolute;
            right: 0;
            top: 0;
            transition: opacity .15s linear;
          }
          .gsi-material-button:hover {
            background-color: #f7f9f9;
            border-color: #c7c7c7;
          }
          .gsi-material-button:focus {
            background-color: #ffffff;
            border-color: #4285f4;
          }
        ` }} />
      </div>
    );
  }

  return (
    <div className="bg-slate-900/60 rounded-xl p-5 border border-white/5 shadow-xl select-none flex flex-col min-h-[380px]">
      {/* Header and User Details */}
      <div className="flex items-center justify-between mb-4 pb-2 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-1.5">
          <Cloud className="w-4 h-4 text-indigo-400" />
          <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest font-mono">
            Drive Explorer
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-400 max-w-[80px] truncate" title={user.email}>
            {user.displayName || user.email?.split("@")[0]}
          </span>
          <button 
            type="button"
            onClick={handleLogout}
            className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded hover:bg-white/5"
            title="Disconnect Google Account"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Error Output bar */}
      {errorCode && (
        <div className="text-[10px] flex items-start gap-1.5 font-mono p-2.5 rounded bg-rose-950/20 border border-rose-950/40 text-rose-400 mb-3 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{errorCode}</span>
        </div>
      )}

      {/* Search Input bar */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <div className="flex-1 relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
          <input 
            type="text" 
            placeholder="Search PDF invoices..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyPress}
            className="w-full bg-[#0c0c0e]/80 border border-white/5 rounded-lg pl-8 pr-3 py-1.5 font-mono text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <button 
          type="button"
          onClick={fetchDriveFiles}
          disabled={loadingFiles}
          className="bg-indigo-600/30 text-indigo-400 hover:bg-indigo-600/55 p-2 rounded-lg border border-indigo-500/20 disabled:opacity-55 cursor-pointer transition-all"
          title="Search"
        >
          {loadingFiles ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Files List viewport */}
      <div className="flex-1 overflow-y-auto max-h-[220px] bg-[#0c0c0e]/40 rounded-lg p-2 border border-white/5 space-y-1">
        {loadingFiles ? (
          <div className="flex flex-col items-center justify-center p-8 text-center h-full min-h-[140px]">
            <Loader2 className="w-6 h-6 text-indigo-400 animate-spin mb-2" />
            <p className="text-[10px] text-slate-500 font-mono">Querying Drive items...</p>
          </div>
        ) : files.length === 0 ? (
          <div className="text-center py-10 text-slate-600">
            <FolderOpen className="w-6 h-6 mx-auto stroke-1 mb-1.5 opacity-30" />
            <p className="text-[10px] font-mono">No PDF files found</p>
          </div>
        ) : (
          files.map(file => {
            const isImporting = importingId === file.id;
            const isImported = importedIds.has(file.id);

            return (
              <div 
                key={file.id} 
                className="group flex items-center justify-between p-2 rounded bg-white/[0.01] hover:bg-white/[0.03] border border-transparent hover:border-white/5 transition-all text-left"
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1 pr-2">
                  <div className="text-indigo-400 bg-indigo-500/5 p-1 rounded shrink-0.5 mt-0.5">
                    <FileText className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-slate-300 truncate" title={file.name}>
                      {file.name}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-slate-500 font-mono">
                      <span>{formatBytes(file.size)}</span>
                      <span>•</span>
                      <span>{formatModifiedTime(file.modifiedTime)}</span>
                    </div>
                  </div>
                </div>

                <div className="shrink-0">
                  {isImported ? (
                    <span className="text-green-400 bg-green-500/5 p-1.5 rounded flex items-center" title="Added to queue">
                      <CheckCircle className="w-3.5 h-3.5" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleImportFile(file)}
                      disabled={isImporting}
                      className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded p-1.5 transition-colors cursor-pointer flex items-center justify-center"
                      title="Load this PDF into Queue"
                    >
                      {isImporting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <DownloadCloud className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-3 text-[10px] text-slate-500 font-sans text-center bg-white/[0.01] py-1.5 px-2.5 rounded border border-white/5 shrink-0">
        💡 Invoices are added to the processing queue.
      </div>
    </div>
  );
}
