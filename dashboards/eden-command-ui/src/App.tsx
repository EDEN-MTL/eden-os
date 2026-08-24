import { useCallback, useState } from "react";
import Atmosphere from "./components/Atmosphere";
import TopBar from "./components/TopBar";
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

        {activeTab === "COMMAND" ? (
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
      </div>
    </div>
  );
}
