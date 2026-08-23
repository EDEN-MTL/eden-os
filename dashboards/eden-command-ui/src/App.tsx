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

export default function App() {
  const [activeTab, setActiveTab] = useState("COMMAND");
  const [selectedAgent, setSelectedAgent] = useState("SCT");
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [panelsOpen, setPanelsOpen] = useState(false);

  const handleVoiceLevelChange = useCallback((level: number) => setVoiceLevel(level), []);

  return (
    <div className="eden-root">
      <Atmosphere />
      <div className="eden-shell">
        <TopBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
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
        ) : (
          <ModuleScreen tab={activeTab} />
        )}
      </div>
    </div>
  );
}
