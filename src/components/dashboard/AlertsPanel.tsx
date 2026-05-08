"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { Alert } from "@/lib/types";
import { AlertTriangle, Bell, X, Zap, TrendingUp } from "lucide-react";

interface Props {
  alerts: Alert[];
  onDismiss: (id: string) => void;
}

export function AlertsPanel({ alerts, onDismiss }: Props) {
  const activeAlerts = alerts.filter((a) => !a.dismissed);
  const criticalCount = activeAlerts.filter((a) => a.severity === "critical").length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Zap className={`w-4 h-4 ${criticalCount > 0 ? "text-impact-high animate-pulse-live" : "text-yellow-400"}`} />
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            Alerts
          </h2>
          {activeAlerts.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold font-mono ${
              criticalCount > 0 ? "bg-impact-high/20 text-impact-high" : "bg-impact-medium/20 text-impact-medium"
            }`}>
              {activeAlerts.length}
            </span>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-2">
          {activeAlerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Bell className="w-8 h-8 mb-2 opacity-30" />
              <span className="text-xs">No active alerts</span>
              <span className="text-[10px] mt-1">
                Alerts fire for high-impact events within 30 min
              </span>
            </div>
          ) : (
            activeAlerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} onDismiss={onDismiss} />
            ))
          )}

          {/* Info section */}
          <div className="mt-4 pt-3 border-t border-border">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Alert Rules
            </h3>
            <div className="space-y-1.5 text-[10px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-impact-high" />
                High-impact event within 5 min
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-impact-medium" />
                High-impact event within 30 min
              </div>
              <div className="flex items-center gap-1.5">
                <TrendingUp className="w-2 h-2" />
                Actual vs Forecast deviation &gt; 20%
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function AlertCard({ alert, onDismiss }: { alert: Alert; onDismiss: (id: string) => void }) {
  const severityConfig = {
    critical: {
      border: "border-impact-high",
      bg: "bg-impact-high/10",
      icon: <AlertTriangle className="w-3.5 h-3.5 text-impact-high" />,
      badge: "bg-impact-high/20 text-impact-high",
    },
    warning: {
      border: "border-impact-medium",
      bg: "bg-impact-medium/10",
      icon: <AlertTriangle className="w-3.5 h-3.5 text-impact-medium" />,
      badge: "bg-impact-medium/20 text-impact-medium",
    },
    info: {
      border: "border-primary",
      bg: "bg-primary/10",
      icon: <Bell className="w-3.5 h-3.5 text-primary" />,
      badge: "bg-primary/20 text-primary",
    },
  }[alert.severity];

  return (
    <div
      className={`rounded-lg border ${severityConfig.border} ${severityConfig.bg} p-3 ${
        alert.severity === "critical" ? "animate-pulse-live" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        {severityConfig.icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[9px] px-1 py-0.5 rounded font-bold uppercase ${severityConfig.badge}`}>
              {alert.severity}
            </span>
            <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-mono uppercase">
              {alert.type.replace(/_/g, " ")}
            </span>
          </div>
          <h4 className="text-xs font-semibold text-foreground">{alert.title}</h4>
          <p className="text-[11px] text-secondary-foreground mt-0.5">{alert.message}</p>
        </div>
        <button
          onClick={() => onDismiss(alert.id)}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
