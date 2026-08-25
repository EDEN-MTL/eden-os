import { useCallback, useState } from "react";
import Atmosphere from "./components/Atmosphere";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import AgentNetwork from "./components/AgentNetwork";
import ReactorCore from "./components/ReactorCore";
import AgentDossierPanel from "./components/AgentDossierPanel";
import CoreMetricsPanel from "./components/CoreMetricsPanel";
import AgentsPanel from "./components/AgentsPanel";
import ChatPanel from "./components/ChatPanel";
import LiveFeedPanel from "./components/LiveFeedPanel";
import ClientPanel from "./components/ClientPanel";
import ModuleScreen from "./components/ModuleScreen";
import SettingsPage from "./components/SettingsPage";
import ClientsListPage from "./components/ClientsListPage";
import ClientDetailPage from "./components/ClientDetailPage";

/**
 * Two shells, deliberately.
 *
 * Command Center keeps the reactor: full-bleed, the orb reacting to EDEN's
 * voice, chat over the top. It is the screen you talk to.
 *
 * Everything else runs in the console — persistent sidebar, card surfaces,
 * plain type. Those are screens you work in, and the reactor's atmosphere
 * (drifting starfield, scanlines, glow) actively gets in the way of reading a
 * table of leads.
 */
export default function App() {
  const [activeTab, setActiveTab] = useState("COMMAND");
  const [selectedAgent, setSelectedAgent] = useState("SCT");
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const handleVoiceLevelChange = useCallback((level: number) => setVoiceLevel(level), []);

  function handleTabChange(tab: string) {
    if (tab !== "CLIENTS") setSelectedClientId(null);
    setActiveTab(tab);
  }

  // The reactor screen, unchanged.
  if (activeTab === "COMMAND") {
    return (
      <div className="eden-root">
        <Atmosphere />
        <div className="eden-shell">
          <TopBar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            panelsOpen={panelsOpen}
            onTogglePanels={() => setPanelsOpen((v) => !v)}
          />
          <div className="columns">
            {panelsOpen && (
              <div className="col-left">
                <AgentDossierPanel selectedCode={selectedAgent} />
                <CoreMetricsPanel />
                <AgentsPanel selectedCode={selectedAgent} onSelectAgent={setSelectedAgent} />
              </div>
            )}
            <div className="col-center">
              <ReactorCore selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} voiceLevel={voiceLevel} />
              <ChatPanel onVoiceLevelChange={handleVoiceLevelChange} />
            </div>
            {panelsOpen && (
              <div className="col-right">
                <LiveFeedPanel />
                <ClientPanel />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console">
      <Sidebar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
      />
      <main className="console-main">
        {activeTab === "AGENTS" ? (
          <AgentNetwork selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} />
        ) : activeTab === "SETTINGS" ? (
          <SettingsPage />
        ) : activeTab === "CLIENTS" ? (
          selectedClientId ? (
            <ClientDetailPage clientId={selectedClientId} onBack={() => setSelectedClientId(null)} />
          ) : (
            <ClientsListPage onSelectClient={setSelectedClientId} />
          )
        ) : (
          <ModuleScreen tab={activeTab} />
        )}
      </main>
    </div>
  );
}
