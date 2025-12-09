import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
} from "recharts";
import "./App.css";

const BACKEND_URL = "http://localhost:5000"; // keep same as your existing file

function numberOrZero(v) {
  return typeof v === "number" ? v : 0;
}

function downloadCSV(filename, rows) {
  if (!rows || rows.length === 0) return;
  const header = Object.keys(rows[0] || {});
  const csv =
    header.join(",") +
    "\n" +
    rows
      .map((r) =>
        header
          .map((h) => {
            const v = r[h] === undefined || r[h] === null ? "" : `${r[h]}`;
            return `"${v.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
      .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [meta, setMeta] = useState({ years: [], sectors: [] });
  const [lineData, setLineData] = useState([]);
  const [selectedYear, setSelectedYear] = useState("");
  const [selectedSector, setSelectedSector] = useState("All");
  const [emissions, setEmissions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loadingData, setLoadingData] = useState(false);

  // Chat states
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [internetSearch, setInternetSearch] = useState(false);
  const chatRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    const fetchMeta = async () => {
      try {
        const res = await axios.get(`${BACKEND_URL}/api/meta`);
        setMeta(res.data || { years: [], sectors: [] });
        if (res.data && res.data.years && res.data.years.length > 0) {
          setSelectedYear(String(res.data.years[res.data.years.length - 1]));
        }
      } catch (err) {
        console.error("Error fetching meta", err);
      }
    };
    fetchMeta();
  }, []);

  useEffect(() => {
    const buildLineData = async () => {
      if (!meta || !Array.isArray(meta.years) || meta.years.length === 0) {
        setLineData([]);
        return;
      }
      try {
        const years = meta.years;
        const arr = [];
        for (const y of years) {
          // call the same endpoint you already use for emissions
          const res = await axios.get(`${BACKEND_URL}/api/emissions`, { params: { year: y } });
          const rows = res.data || [];
          // sum all sector values for that year
          const total = rows.reduce((s, it) => s + (typeof it.value === 'number' ? it.value : Number(it.value || 0)), 0);
          arr.push({ year: y, total });
        }
        setLineData(arr);
        // Dev log so you can confirm
        console.log("lineData built:", arr);
      } catch (err) {
        console.error("Error building lineData:", err);
        setLineData([]);
      }
    };
    buildLineData();
  }, [meta]);


  useEffect(() => {
    async function load() {
      if (!selectedYear) return;
      setLoadingData(true);
      try {
        const params = { year: selectedYear };
        const res = await axios.get(`${BACKEND_URL}/api/emissions`, { params });
        const data = res.data || [];
        const filtered = selectedSector && selectedSector !== "All"
          ? data.filter((d) => d.sector === selectedSector)
          : data;

        const bySector = {};
        filtered.forEach((r) => {
          bySector[r.sector] = numberOrZero(r.value) + (bySector[r.sector] || 0);
        });
        const barArray = Object.keys(bySector).map((k) => ({ sector: k, value: bySector[k] }));
        setEmissions(barArray);

        const summRes = await axios.get(`${BACKEND_URL}/api/summary`, { params });
        setSummary(summRes.data || null);
      } catch (err) {
        console.error("Error loading data", err);
      } finally {
        setLoadingData(false);
      }
    }
    load();
  }, [selectedYear, selectedSector]);

  // CHAT
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSending && chatInput.trim() !== "") handleSendChat();
    }
  };

  const addUserMessage = (text) => {
    setChatMessages((p) => [...p, { from: "user", text, time: new Date().toISOString() }]);
  };
  const addBotMessage = (text, meta = {}) => {
    setChatMessages((p) => [...p, { from: "bot", text, time: new Date().toISOString(), ...meta }]);
  };

  const handleSendChat = async () => {
    const message = chatInput.trim();
    if (!message || isSending) return;
    addUserMessage(message);
    setChatInput("");
    setIsSending(true);

    try {
      if (internetSearch) {
        // call backend search endpoint (your backend should expose /api/search or /api/chat handles internet flag)
        const resp = await axios.get(`${BACKEND_URL}/api/search`, { params: { q: message } });
        const items = resp.data.results || [];
        if (items.length === 0) {
          addBotMessage("No web results found.", { source: "web" });
        } else {
          const listText = items.map((it, i) => `${i + 1}. ${it.title}\n${it.link}`).join("\n\n");
          addBotMessage(`Top web results:\n\n${listText}`, { source: "web" });
        }
      } else {
        const res = await axios.post(`${BACKEND_URL}/api/chat`, { message, internet: false });
        const data = res.data || {};
        addBotMessage(data.answer || "No answer returned.", { source: data.source || "local" });
      }
    } catch (err) {
      console.error("Chat/search error", err);
      addBotMessage("Error contacting search/chat service.", { source: "error" });
    } finally {
      setIsSending(false);
    }
  };

  const suggestionClicks = (text) => {
    setChatInput(text);
    const el = document.querySelector(".chat-input");
    if (el) el.focus();
  };

  const totalEmissions =
    summary && summary.summary ? Object.values(summary.summary).reduce((a, b) => a + b, 0) : null;
  const numberOfSectors = summary && summary.summary ? Object.keys(summary.summary).length : emissions.length;

  const handleExportCSV = () => {
    if (!emissions || emissions.length === 0) {
      alert("No data to export");
      return;
    }
    const rows = emissions.map((r) => ({ year: selectedYear, sector: r.sector, value: r.value }));
    downloadCSV(`emissions_${selectedYear}.csv`, rows);
  };

  return (
    <div className="app-container">
      <main className="dashboard">
        <header className="top-header">
          <div>
            <h1>Emissions Dashboard</h1>
            <p className="subtitle">Explore emissions by sector and year. Use the chat panel to ask questions or fetch live web insights.</p>
          </div>

          <div className="controls-row">
            <div className="filter">
              <label>Year:&nbsp;
                <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
                  <option value="">-- select --</option>
                  {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>

              <label style={{ marginLeft: 12 }}>Sector:&nbsp;
                <select value={selectedSector} onChange={(e) => setSelectedSector(e.target.value)}>
                  <option value="All">All</option>
                  {meta.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>

            <div className="actions">
              <button className="btn small" onClick={handleExportCSV}>Export CSV</button>
            </div>
          </div>
        </header>

        <section className="cards">
          <div className="card">
            <h4>Total emissions (selected year)</h4>
            <p className="card-value">{loadingData ? "Loading…" : totalEmissions !== null ? `${totalEmissions.toFixed(1)} MtCO₂e` : "-"}</p>
          </div>

          <div className="card">
            <h4>Number of sectors</h4>
            <p className="card-value">{loadingData ? "…" : numberOfSectors}</p>
          </div>

          <div className="card">
            <h4>Selected filters</h4>
            <p className="card-value small">Year: <strong>{selectedYear || "-"}</strong><br/>Sector: <strong>{selectedSector}</strong></p>
          </div>
        </section>

        <section className="charts">
          <div className="chart-card">
            <div className="chart-header"><h3>Emissions by sector (bar chart)</h3><div className="chart-help">Hover bars for details</div></div>
            <div className="chart-body">
              {loadingData ? <div className="loader">Loading chart…</div> :
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={emissions} margin={{ top: 16, right: 16, left: 8, bottom: 32 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="sector" />
                    <YAxis />
                    <Tooltip formatter={(value) => `${value} MtCO₂e`} />
                    <Bar dataKey="value" fill="#7b68ee" />
                  </BarChart>
                </ResponsiveContainer>
              }
            </div>
          </div>

          <div className="chart-card">
            <div className="chart-header"><h3>Trend over years (line chart)</h3><div className="chart-help">Total emissions trend across available years</div></div>
            <div className="chart-body">
              {lineData.length === 0 ? <div className="loader">Loading trend…</div> :
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={lineData} margin={{ top: 8, right: 24, left: 8, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="year" />
                    <YAxis />
                    <Tooltip formatter={(value) => `${value} MtCO₂e`} />
                    <Line type="monotone" dataKey="total" stroke="#4caf50" strokeWidth={2} dot />
                    <Legend />
                  </LineChart>
                </ResponsiveContainer>
              }
            </div>
          </div>
        </section>

        <footer className="footer-note"><small>Tip: Try chat suggestions or check "Search web" to fetch live web snippets (requires backend search API).</small></footer>
      </main>

      <aside className="chat-panel" aria-live="polite">
        <div className="chat-title">
          <h3>Chat about emissions</h3>
          <div className="chat-subtitle">Ask about this dashboard or request web insights</div>
        </div>

        <div className="chat-suggestions">
          <button className="chip" onClick={() => suggestionClicks("Which sector is highest in 2020?")}>Which sector is highest in 2020?</button>
          <button className="chip" onClick={() => suggestionClicks("Global CO2 emissions 2023")}>Global CO₂ emissions 2023</button>
          <button className="chip" onClick={() => suggestionClicks("India CO2 emissions latest")}>India CO₂ emissions latest</button>
        </div>

        <div className="chat-messages" ref={chatRef}>
          {chatMessages.map((m, i) => (
            <div key={i} className={`chat-bubble ${m.from === "user" ? "chat-user" : "chat-bot"}`}>
              <div className="bubble-meta"><strong>{m.from === "user" ? "You" : "Assistant"}</strong>{m.source && <span className="source-tag">{m.source}</span>}</div>
              <div className="bubble-text" style={{whiteSpace: "pre-wrap"}}>{m.text}</div>
              {m.url && <div className="bubble-link"><a href={m.url} target="_blank" rel="noreferrer">{m.title || m.url}</a></div>}
            </div>
          ))}
        </div>

        <div className="chat-input-row">
          <textarea className="chat-input" placeholder="Ask about emissions... (Enter to send, Shift+Enter for newline)"
            value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={handleKeyDown}
            rows={1} disabled={isSending} />
          <div className="chat-controls">
            <label className="search-toggle"><input type="checkbox" checked={internetSearch} onChange={(e) => setInternetSearch(e.target.checked)} /><span>Search web</span></label>
            <button className="btn" onClick={handleSendChat} disabled={isSending || chatInput.trim() === ""}>{isSending ? "Sending…" : "Send"}</button>
          </div>
        </div>
      </aside>
    </div>
  );
}
