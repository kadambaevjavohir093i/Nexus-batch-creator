import { useState, useCallback, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { 
  FileText, 
  Trash2, 
  Upload, 
  Download, 
  Play, 
  X, 
  RefreshCw, 
  ShieldCheck, 
  FileSpreadsheet, 
  AlertCircle,
  Truck,
  Cloud
} from "lucide-react";
import DriveBrowser from "./components/DriveBrowser";

// Define table column structure exactly as required by the company format
interface ColumnConfig {
  key: string;
  label: string;
}


const COLUMNS: ColumnConfig[] = [
  { key: "num",         label: "#" },
  { key: "invoice",     label: "INVOICE#" },
  { key: "date",        label: "DATE" },
  { key: "unit",        label: "UNIT" },
  { key: "responsible", label: "RESPONSIBLE" },
  { key: "name",        label: "NAME" },
  { key: "cost",        label: "COST" },
  { key: "note",        label: "NOTE" },
  { key: "wo",          label: "WO#" },
];

interface EngineInfo {
  provider: string;
  model: string;
  effort: string;
  configured: boolean;
}

interface FileEntry {
  id: string;
  file: File;
  name: string;
  status: "idle" | "reading" | "extracting" | "done" | "error";
  rowCount: number | null;
  error: string | null;
  rows?: any[];
  isTruckInvoice?: boolean;
  detectedBrand?: string | null;
  reasons?: string;
}

export default function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [batchLabel, setBatchLabel] = useState<string>("BATCH #72 JRD");
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"local" | "cloud">("local");
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ask the server which Claude model is actually wired up.
  useEffect(() => {
    fetch("/api/config")
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data) setEngine(data); })
      .catch(() => setEngine(null));
  }, []);

  // Expose a function to add single file retrieved from Drive
  const handleDriveFileImported = useCallback((fileObj: File) => {
    const cleanName = fileObj.name.replace(/\.[^/.]+$/, "").toUpperCase();
    setBatchLabel(cleanName);
    setFiles(prev => {
      if (prev.some(f => f.name === fileObj.name)) return prev;
      return [
        ...prev,
        {
          id: Math.random().toString(36).slice(2),
          file: fileObj,
          name: fileObj.name,
          status: "idle" as const,
          rowCount: null,
          error: null,
        }
      ];
    });
  }, []);


  // Derived state from the files queue to stay perfectly in sync
  const activeTruckFiles = files.filter(f => f.status === "done" && f.isTruckInvoice === true && f.rows && f.rows.length > 0);
  const allRows = activeTruckFiles.flatMap(f => f.rows || []);

  // Add files callback supporting multiple PDF drop or selections
  const addFiles = useCallback((newFiles: FileList | null) => {
    if (!newFiles) return;
    const pdfs = Array.from(newFiles).filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    
    if (pdfs.length === 1) {
      setBatchLabel(pdfs[0].name.replace(/\.[^/.]+$/, "").toUpperCase());
    } else {
      setBatchLabel(`${pdfs[0].name.replace(/\.[^/.]+$/, "").toUpperCase()}_AND_OTHERS`);
    }

    setFiles(prev => [
      ...prev,
      ...pdfs.map(f => ({
        id: Math.random().toString(36).slice(2),
        file: f,
        name: f.name,
        status: "idle" as const,
        rowCount: null,
        error: null,
      }))
    ]);
  }, []);

  // API Call helper to post file base64 data to our server
  const extractFromPDF = async (base64: string): Promise<any> => {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64 })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData?.error || `API error ${response.status}`);
    }

    return await response.json();
  };

  // Process a single file
  const processFile = async (entry: FileEntry) => {
    setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, status: "reading", error: null } : f));
    
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const resultStr = reader.result as string;
          resolve(resultStr.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(entry.file);
      });

      setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, status: "extracting" } : f));

      const result = await extractFromPDF(base64);
      
      const isTruck = result.isTruckInvoice;
      const detectedBrand = result.detectedBrand;
      const reasons = result.reasons;
      const rows = result.items || [];

      if (!isTruck) {
        setFiles(prev => prev.map(f => f.id === entry.id ? { 
          ...f, 
          status: "done", 
          rowCount: 0,
          isTruckInvoice: false,
          detectedBrand: detectedBrand || "Unknown / Non-Truck",
          reasons: reasons || "Not a commercial semi-truck repair invoice.",
          rows: []
        } : f));
        return;
      }

      // Successfully processed
      setFiles(prev => prev.map(f => f.id === entry.id ? { 
        ...f, 
        status: "done", 
        rowCount: rows.length,
        isTruckInvoice: true,
        detectedBrand,
        reasons,
        rows
      } : f));
    } catch (err: any) {
      setFiles(prev => prev.map(f => f.id === entry.id ? { 
        ...f, 
        status: "error", 
        error: err.message || "Extraction failed" 
      } : f));
    }
  };

  // Process all files in queue sequentially 
  const processAll = async () => {
    const toProcess = files.filter(f => f.status === "idle" || f.status === "error");
    if (!toProcess.length) return;
    setIsProcessing(true);

    for (const f of toProcess) {
      await processFile(f);
    }
    setIsProcessing(false);
  };

  // Remove single file (derived state handles rows automatically)
  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearAll = () => {
    setFiles([]);
  };

  // Download XLS File styled with margins and aligned headings
  const downloadXLSX = () => {
    if (!activeTruckFiles.length) return;
    const wb = XLSX.utils.book_new();
    
    const sheetData: any[][] = [
      [] // Top padding margin row
    ];

    activeTruckFiles.forEach((fileEntry, idx) => {
      // Clear PDF extension and convert to uppercase for clean display titles
      const fileTitle = fileEntry.name.replace(/\.[^/.]+$/, "").toUpperCase();

      // Add space separator rows between files matching user reference
      if (idx > 0) {
        sheetData.push([]);
        sheetData.push([]);
      }

      // Add the file title as section heading (in column B, leaving column A blank as a margin)
      sheetData.push([null, fileTitle]);
      // Add table column headers block for this file
      sheetData.push([null, ...COLUMNS.map(c => c.label)]);

      let fileRowTracker = 1;

      if (fileEntry.rows) {
        fileEntry.rows.forEach(r => {
          sheetData.push([
            null,
            r.num ?? fileRowTracker++,
            r.invoice ?? null,
            r.date ?? null,
            r.unit ?? null,
            r.responsible ?? null,
            r.name ?? null,
            r.cost ?? null,
            r.note ?? null,
            r.wo ?? null,
          ]);
        });
      }
    });

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    
    // Set specific Column widths for optimal layout in excel
    ws["!cols"] = [
      { wch: 3 }, { wch: 5 }, { wch: 12 }, { wch: 12 }, { wch: 8 },
      { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 60 }, { wch: 10 },
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, `${batchLabel.replace(/\s+/g, "_")}.xlsx`);
  };

  // Math metrics
  const totalValue = allRows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
  const formattedTotal = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(totalValue);

  const hasQuotaError = files.some(
    f => 
      f.status === "error" && 
      f.error && 
      (f.error.toLowerCase().includes("depleted") || 
       f.error.toLowerCase().includes("quota") || 
       f.error.toLowerCase().includes("credit") || 
       f.error.toLowerCase().includes("429") || 
       f.error.toLowerCase().includes("resource_exhausted"))
  );

  return (
    <div className="bg-[#09090b] text-slate-200 min-h-screen w-full overflow-x-hidden flex flex-col font-sans">
      
      {/* Header */}
      <header className="h-20 border-b border-white/10 flex items-center justify-between px-8 bg-[#0c0c0e] shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-indigo-600 rounded flex items-center justify-center text-xl shadow-lg shadow-indigo-500/20">
            <Truck className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white mb-0.5">Logistics Data Forge</h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-mono font-medium">AI-Powered Repair Invoice Extraction</p>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Active Batch</span>
            <input 
              type="text" 
              value={batchLabel} 
              onChange={e => setBatchLabel(e.target.value)}
              className="bg-transparent border-none text-indigo-400 font-mono text-sm focus:outline-none focus:ring-0 text-right p-0 font-bold placeholder-indigo-700/60"
              placeholder="BATCH ID"
            />
          </div>
          {allRows.length > 0 && (
            <button 
              onClick={downloadXLSX}
              className="bg-white text-black px-5 py-2 rounded text-xs font-bold hover:bg-slate-200 transition-all flex items-center gap-2 cursor-pointer shadow-md"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Export to XLSX</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        
        {/* Sidebar */}
        <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-white/5 bg-[#0c0c0e] flex flex-col shrink-0">
          
          {/* Tabs Selector Header */}
          <div className="p-4 pb-2 flex gap-2 border-b border-white/5 bg-[#0a0a0c] shrink-0">
            <button
              onClick={() => setActiveTab("local")}
              className={`flex-1 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer border ${
                activeTab === "local" 
                  ? "bg-indigo-600/15 text-indigo-400 border-indigo-500/30" 
                  : "text-slate-500 hover:text-slate-300 hover:bg-white/[0.01] border-transparent"
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Local</span>
            </button>
            <button
              onClick={() => setActiveTab("cloud")}
              className={`flex-1 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer border ${
                activeTab === "cloud" 
                  ? "bg-indigo-600/15 text-indigo-400 border-indigo-500/30" 
                  : "text-slate-500 hover:text-slate-300 hover:bg-white/[0.01] border-transparent"
              }`}
            >
              <Cloud className="w-3.5 h-3.5" />
              <span>Google Drive</span>
            </button>
          </div>

          {/* Active Tab Body */}
          <div className="shrink-0 border-b border-white/5 bg-[#0c0c0e] p-4">
            {activeTab === "local" ? (
              <div className="space-y-4">
                {/* File input Upload Zone */}
                <div 
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
                  onClick={() => inputRef.current?.click()}
                  className={`border border-dashed rounded-xl p-5 text-center cursor-pointer transition-all ${
                    isDragging 
                      ? "border-indigo-500 bg-indigo-500/10" 
                      : "border-slate-800 bg-white/[0.01] hover:bg-white/[0.03] hover:border-slate-700"
                  }`}
                >
                  <input 
                    ref={inputRef} 
                    type="file" 
                    accept=".pdf" 
                    multiple 
                    onChange={e => addFiles(e.target.files)} 
                    className="hidden" 
                  />
                  <div className="w-8 h-8 bg-slate-800/40 rounded-full flex items-center justify-center mx-auto mb-2">
                    <Upload className="w-4 h-4 text-indigo-400" />
                  </div>
                  <p className="text-[11px] text-slate-300 font-medium mb-0.5">Drop repair PDFs here</p>
                  <p className="text-[9px] text-slate-500">Supports multiple PDF files</p>
                </div>

                {/* Truck Brands Landmark Guide */}
                <div className="bg-slate-900/40 rounded-xl p-3 border border-white/5 shadow-xl">
                  <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-widest block mb-1 flex items-center gap-1 font-mono">
                    <Truck className="w-3 h-3" />
                    <span>Verified semi trucks</span>
                  </span>
                  <p className="text-[10px] text-slate-400 leading-normal font-sans">
                    Verifies invoices belonging to major commercial truck manufacturers:
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {["Freightliner", "Peterbilt", "Volvo", "Kenworth", "Mack"].map(b => (
                      <span key={b} className="text-[8px] px-1.5 py-0.5 bg-white/[0.03] text-slate-400 rounded font-mono">
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <DriveBrowser onFileImported={handleDriveFileImported} />
            )}
          </div>

          {/* Files Queue List */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
            <div className="flex items-center justify-between px-1 mb-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Queue ({files.length})</span>
              {files.length > 0 && (
                <button 
                  onClick={clearAll} 
                  className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase font-mono tracking-tighter"
                >
                  Clear All
                </button>
              )}
            </div>

            {files.length === 0 ? (
              <div className="text-center py-12 text-slate-600">
                <FileText className="w-8 h-8 mx-auto stroke-1 mb-2 opacity-40" />
                <p className="text-[11px] font-sans">Queue is empty</p>
              </div>
            ) : (
              files.map(f => {
                let badgeClass = "text-slate-500 bg-slate-500/10";
                let badgeText = "Waiting";
                let pulseClass = "";

                if (f.status === "reading") {
                  badgeClass = "text-amber-400 bg-amber-400/10";
                  badgeText = "Reading PDF...";
                  pulseClass = "animate-pulse";
                } else if (f.status === "extracting") {
                  badgeClass = "text-sky-400 bg-sky-400/10";
                  badgeText = "AI Extracting...";
                  pulseClass = "animate-pulse";
                } else if (f.status === "done") {
                  if (f.isTruckInvoice === false) {
                    badgeClass = "text-rose-500 bg-rose-500/10";
                    badgeText = "No Truck Found ✕";
                  } else {
                    badgeClass = "text-green-400 bg-green-400/10";
                    badgeText = `Done ✓ ${f.rowCount || 0} ${f.rowCount === 1 ? 'row' : 'rows'}`;
                  }
                } else if (f.status === "error") {
                  badgeClass = "text-rose-400 bg-rose-400/10";
                  badgeText = "Failed ✕";
                }

                return (
                  <div key={f.id} className="group flex flex-col gap-2 p-3 bg-white/[0.02] rounded-lg border border-white/5 hover:border-white/10 transition-all">
                    <div className="flex items-start gap-3 w-full">
                      <div className="text-slate-400 bg-slate-900/60 p-1.5 rounded mt-0.5">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0 pr-1">
                        <p className="text-xs font-medium text-slate-300 truncate" title={f.name}>
                          {f.name}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`text-[9px] font-bold uppercase py-0.5 px-1.5 rounded tracking-wide ${badgeClass} ${pulseClass}`}>
                            {badgeText}
                          </span>
                          {f.status === "done" && f.isTruckInvoice && f.detectedBrand && (
                            <span className="text-[9px] font-bold uppercase py-0.5 px-1.5 rounded tracking-wide text-indigo-400 bg-indigo-400/10 flex items-center gap-1">
                              <span>🚚</span>
                              <span>{f.detectedBrand}</span>
                            </span>
                          )}
                          {f.status === "error" && f.error && (
                            <span className="text-[9px] text-rose-400 truncate max-w-full font-mono block" title={f.error}>
                              {f.error}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center">
                        <button 
                          onClick={() => removeFile(f.id)}
                          className="text-slate-600 hover:text-slate-300 p-1 rounded hover:bg-white/5 transition-all opacity-0 group-hover:opacity-100"
                          title="Remove file"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    {f.status === "done" && f.reasons && (
                      <div className={`text-[10px] p-2 rounded leading-relaxed border font-mono ${
                        f.isTruckInvoice 
                          ? "bg-indigo-950/20 text-slate-400 border-indigo-900/20" 
                          : "bg-rose-950/20 text-rose-400 border-rose-950/30"
                      }`}>
                        {f.isTruckInvoice ? "✓ " : "⚠️ "}{f.reasons}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Action Footer in Sidebar */}
          {files.some(f => f.status === "idle" || f.status === "error") && (
            <div className="p-4 border-t border-white/5 bg-[#0a0a0f]">
              <button 
                onClick={processAll}
                disabled={isProcessing}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white py-3 rounded-lg text-xs font-bold uppercase tracking-widest transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw className="w-4.5 h-4.5 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current text-white" />
                    <span>Process {files.filter(f => f.status === "idle" || f.status === "error").length} PDF Files</span>
                  </>
                )}
              </button>
            </div>
          )}
        </aside>

        {/* Data View Section */}
        <section className="flex-1 bg-[#09090b] p-8 flex flex-col overflow-y-auto min-w-0">
          
          {/* Section banner */}
          <div className="flex flex-col md:flex-row md:items-baseline justify-between gap-4 mb-6">
            <div>
              <h2 className="text-2xl font-serif italic text-slate-100 font-medium tracking-tight">Extracted Recordset</h2>
              <p className="text-xs text-slate-500 font-mono tracking-tight mt-1">Previewing extracted truck repair records for active batch workbook</p>
            </div>
            
            {allRows.length > 0 && (
              <div className="flex items-center gap-4 bg-[#0c0c0e] border border-white/5 rounded-lg px-4 py-2 font-mono">
                <span className="text-xs text-slate-500 uppercase">Total Value:</span>
                <span className="text-emerald-400 font-bold">{formattedTotal}</span>
                <span className="text-slate-700">|</span>
                <span className="text-xs text-indigo-400 font-bold">{allRows.length} Rows</span>
              </div>
            )}
          </div>

          {hasQuotaError && (
            <div className="mb-6 p-5 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-xl flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 shadow-xl">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 shrink-0 bg-rose-950/40 rounded-xl flex items-center justify-center border border-rose-500/20 text-rose-400 mt-1">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white tracking-wide">Anthropic API Credits Depleted or Rate Limited (Error 429)</h4>
                  <p className="text-[11px] text-rose-300/80 mt-1 leading-relaxed max-w-2xl">
                    The active Anthropic API key has run out of credit, or the account has hit its rate limit.
                    Your files will fail extraction until credit is topped up, the limit resets, or the key is replaced.
                  </p>
                  <ul className="list-disc list-inside text-[10px] text-rose-400/85 mt-2 space-y-1 font-mono">
                    <li>Open your dashboard: <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener noreferrer" className="underline text-indigo-400 hover:text-indigo-300 transition-colors">Anthropic Console billing</a></li>
                    <li>Check your plan limits and remaining credit balance.</li>
                    <li>Alternatively, update <span className="text-white px-1 bg-white/5 rounded">ANTHROPIC_API_KEY</span> in your .env file.</li>
                  </ul>
                </div>
              </div>
              <div className="shrink-0 self-end lg:self-center">
                <a 
                  href="https://console.anthropic.com/settings/billing" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="inline-block bg-rose-900 hover:bg-rose-800 text-white font-mono text-[10px] uppercase font-bold py-2.5 px-4 rounded-xl border border-rose-500/20 transition-all text-center shrink-0 shadow"
                >
                  Manage Billing ↗
                </a>
              </div>
            </div>
          )}

          {allRows.length === 0 ? (
            <div className="flex-1 border border-dashed border-white/5 rounded-xl bg-white/[0.01] flex flex-col items-center justify-center text-center p-12">
              <div className="w-16 h-16 bg-[#0c0c0e] rounded-2xl flex items-center justify-center border border-white/10 mb-4 shadow-xl">
                <FileSpreadsheet className="w-8 h-8 text-slate-500" />
              </div>
              <h3 className="text-sm font-semibold text-slate-300">No Extracted Records Yet</h3>
              <p className="text-xs text-slate-500 max-w-sm mt-1 mb-6">
                Upload invoice PDF documents on the left sidebar pane and hit "Process" to instruct the LLM engine to distill tabular record items.
              </p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              
              {/* Table Wrapper border */}
              <div className="flex-1 border border-white/10 rounded-xl overflow-hidden bg-[#0c0c0e]/40 shadow-2xl overflow-x-auto min-w-full">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-white/[0.02] border-b border-white/10 whitespace-nowrap">
                      {COLUMNS.map(c => (
                        <th 
                          key={c.key} 
                          className="px-4 py-3.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest border-r border-white/5"
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 font-mono text-[11px]">
                    {(() => {
                      let rowIdxInPreview = 1;
                      return activeTruckFiles.flatMap((fileEntry, fileIdx) => {
                        const fileRows: any[] = [];

                        // 1. Add spacer row in visualization if not the first file
                        if (fileIdx > 0) {
                          fileRows.push(
                            <tr key={`spacer-${fileEntry.id}`} className="bg-slate-900/40 h-8">
                              <td colSpan={9} className="border-r border-white/5 px-4 text-center text-[10px] text-indigo-400/60 uppercase tracking-widest font-bold">
                                • • • Spacer (Blank Excel Row Added Here) • • •
                              </td>
                            </tr>
                          );
                        }

                        // 2. Add sub-header representing the origin file
                        fileRows.push(
                          <tr key={`header-${fileEntry.id}`} className="bg-indigo-950/20 border-y border-white/5 font-sans">
                            <td colSpan={9} className="px-4 py-2 font-mono text-[10px] uppercase text-indigo-300 font-bold tracking-wider">
                              📁 Invoice PDF: {fileEntry.name} ({fileEntry.detectedBrand || "Verified Truck"})
                            </td>
                          </tr>
                        );

                        // 3. Add each individual row of this file
                        if (fileEntry.rows) {
                          fileEntry.rows.forEach((row, i) => {
                            fileRows.push(
                              <tr 
                                key={`${fileEntry.id}-row-${i}`} 
                                className="hover:bg-white/[0.02] bg-[#0c0c0e]/10 transition-colors"
                              >
                                <td className="px-4 py-3 text-slate-600 border-r border-white/5 whitespace-nowrap font-sans font-medium">
                                  {String(rowIdxInPreview++).padStart(2, '0')}
                                </td>
                                <td className="px-4 py-3 text-white font-bold tracking-tight border-r border-white/5 whitespace-nowrap">
                                  {row.invoice ?? "—"}
                                </td>
                                <td className="px-4 py-3 text-slate-400 border-r border-white/5 whitespace-nowrap">
                                  {row.date ?? "—"}
                                </td>
                                <td className="px-4 py-3 text-indigo-400 font-bold border-r border-white/5 whitespace-nowrap">
                                  {row.unit ?? "—"}
                                </td>
                                <td className="px-4 py-3 text-slate-500 border-r border-white/5 whitespace-nowrap">
                                  {row.responsible ?? "—"}
                                </td>
                                <td className="px-4 py-3 text-slate-500 border-r border-white/5 whitespace-nowrap">
                                  {row.name ?? "—"}
                                </td>
                                <td className="px-4 py-3 text-emerald-400 font-bold font-mono border-r border-white/5 whitespace-nowrap">
                                  {row.cost != null 
                                    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(row.cost) 
                                    : "—"}
                                </td>
                                <td className="px-4 py-3 text-slate-300 font-sans leading-relaxed border-r border-white/5 min-w-[280px]">
                                  {row.note ?? "—"}
                                </td>
                                <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                                  {row.wo ?? "—"}
                                </td>
                              </tr>
                            );
                          });
                        }

                        return fileRows;
                      });
                    })()}
                  </tbody>
                </table>
              </div>

              {/* Centered Export Button */}
              <div className="flex justify-center mt-6">
                <button 
                  onClick={downloadXLSX}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold font-sans py-3 px-8 rounded-lg shadow-lg shadow-emerald-950/45 transition-all flex items-center gap-3.5 cursor-pointer"
                >
                  <Download className="w-4 h-4 text-white" />
                  <span>Download Workbook as XLSX ({allRows.length} rows)</span>
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="h-10 border-t border-white/5 bg-[#0c0c0e] flex items-center justify-between px-8 text-[10px] text-slate-500 font-mono tracking-tighter uppercase shrink-0">
        <div className="flex items-center gap-2">
          <ShieldCheck className={`w-3.5 h-3.5 ${engine?.configured ? "text-emerald-500" : "text-amber-500"}`} />
          <span>
            {engine
              ? engine.configured
                ? `System Active: ${engine.model} Extraction Pipeline`
                : "Inactive: set ANTHROPIC_API_KEY in .env to start extracting"
              : "Connecting to extraction pipeline..."}
          </span>
        </div>
        <div>
          Provider: Anthropic{engine?.effort ? ` • Effort: ${engine.effort}` : ""} • Batch: {batchLabel || "—"}
        </div>
      </footer>
    </div>
  );
}
