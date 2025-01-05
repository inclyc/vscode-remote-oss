import {
    commands,
    Event, EventEmitter,
    ExtensionContext,
    OutputChannel,
    QuickPickItem,
    RemoteAuthorityResolverError,
    ResolvedAuthority,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    window,
    workspace
} from "vscode";
import { HostConfig, HostKind } from "./remotesConfig";

export interface HostInfo {
    type: "transient" | "configured";
    host: string;
    port?: number;
}

export function encode_remote_host(info: HostInfo): string {
    const json = JSON.stringify(info);
    const base64 = Buffer.from(json).toString("base64");
    return `remote-oss+${base64}`;
}

export function decode_remote_host(encoded: string): HostInfo | undefined {
    const match = encoded.match(/remote-oss\+(.*)/);
    if (match) {
        const base64 = match[1];
        const json = Buffer.from(base64, "base64").toString();
        const info: HostInfo = JSON.parse(json);
        return info;
    }
    return undefined;
}

export class HostBase extends TreeItem {
    name: string;
    folders: FolderItem[];

    constructor(label: string) {
        super(label, TreeItemCollapsibleState.None);
        this.name = label;
        this.folders = [];
    }

    addFolder(folder: FolderItem) {
        this.folders.push(folder);
        this.collapsibleState = TreeItemCollapsibleState.Expanded;
    }
}

export class FolderItem extends TreeItem {
    readonly host: string;
    readonly path: string;
    constructor(label: string, host: string, path: string) {
        super(label, TreeItemCollapsibleState.None);
        this.contextValue = 'remote-oss.folder';
        this.iconPath = ThemeIcon.Folder;
        this.host = host;
        this.path = path;
    }
}

class PlainHostItem extends HostBase {
    readonly host: string;
    readonly port: number;
    readonly connectionToken: string | boolean;

    constructor(label: string, host: string, port: number, connectionToken: string | boolean) {
        super(label);
        this.contextValue = 'remote-oss.host';
        this.iconPath = new ThemeIcon("device-desktop");
        this.description = `${host}:${port}`;
        this.host = host;
        this.port = port;
        this.connectionToken = connectionToken;
    }
}



type Host = PlainHostItem;

class KindItem extends TreeItem {
    hosts: Host[] = [];

    constructor(label: string, description?: string) {
        super(label, TreeItemCollapsibleState.Expanded);
        this.contextValue = 'remote-oss.kind';
        this.iconPath = ThemeIcon.Folder;
        this.description = description;
    }

    addHost(host: Host) {
        this.hosts.push(host);
    }
}


type TaskTree = KindItem[] | Host[];

export class RemotesDataProvider implements TreeDataProvider<TreeItem> {
    private remotesTree: TaskTree | null = null;
    private extensionContext: ExtensionContext;
    private _onDidChangeTreeData: EventEmitter<TreeItem | null> = new EventEmitter<TreeItem | null>();
    readonly onDidChangeTreeData: Event<TreeItem | null> = this._onDidChangeTreeData.event;

    constructor(private context: ExtensionContext) {
        const subscriptions = context.subscriptions;
        this.extensionContext = context;
    }

    getTreeItem(element: TreeItem): TreeItem {
        return element;
    }

    getParent(element: TreeItem): TreeItem | null {
        return null;
    }

    async setNoHostsContext(enabled: boolean) {
        await commands.executeCommand("setContext", "remote-oss:noHosts", enabled);
    }

    async readTree() {
        let tree = [];

        var numberOfHosts = 0;
        const value: any = workspace.getConfiguration().get("remote.OSS.hosts");
        if (value) {
            let manual = new KindItem("manual");
            const hosts: HostConfig[] = value;
            for (const host of hosts) {
                if (host.type === HostKind.Manual) {
                    var connectionToken = host.connectionToken;
                    if (!connectionToken && typeof connectionToken !== "boolean") {
                        connectionToken = true;
                    }

                    const hostItem = new PlainHostItem(host.name, host.host, host.port, connectionToken);
                    manual.addHost(hostItem);
                    numberOfHosts += 1;
                    if (host.folders) {
                        for (const folder of host.folders) {
                            const hostName = hostItem.label;
                            if (typeof hostName !== "string") { continue; }
                            if (typeof folder === "string") {
                                hostItem.addFolder(new FolderItem(
                                    folder,
                                    hostName,
                                    folder
                                ));
                            } else {
                                hostItem.addFolder(new FolderItem(
                                    folder.name,
                                    hostName,
                                    folder.path
                                ));
                            }
                        }
                    }
                }
            }
            if (manual.hosts.length > 0) {
                tree.push(manual);
            }
        }

        await this.setNoHostsContext(numberOfHosts === 0);

        this.remotesTree = tree;
        this._onDidChangeTreeData.fire(null);
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!this.remotesTree) {
            await this.readTree();
        }
        if (element instanceof PlainHostItem) {
            return element.folders;
        }
        if (element instanceof KindItem) {
            return element.hosts;
        }
        if (!element) {
            if (this.remotesTree) {
                return this.remotesTree;
            }
        }
        return [];
    }

    async _getHostList(out: Host[], root: TreeItem[]) {
        for (let entry of root) {
            if (entry instanceof PlainHostItem) {
                out.push(entry);
            } else {
                await this._getHostList(out, await this.getChildren(entry));
            }
        }
    }

    async getHostList(): Promise<Host[]> {
        let out: Host[] = [];
        await this._getHostList(out, await this.getChildren());
        return out;
    }

    async pickHostLabel(): Promise<string | undefined> {
        const quickpick = window.createQuickPick();
        quickpick.canSelectMany = false;
        quickpick.show();

        try {
            quickpick.busy = true;

            quickpick.items = (await this.getHostList()).map(h => ({ label: `${h.label}` }));
            quickpick.busy = false;

            const result = await Promise.race([
                new Promise<readonly QuickPickItem[]>(c => quickpick.onDidAccept(() => c(quickpick.selectedItems))),
                new Promise<undefined>(c => quickpick.onDidHide(() => c(undefined)))
            ]);

            if (!result || result.length === 0) {
                return;
            }

            return encode_remote_host({ type: "configured", host: result[0].label });
        } finally {
            quickpick.dispose();
        }
        return;
    }

    async pickToken(): Promise<string | undefined> {
        const raw = await window.showInputBox({
            placeHolder: "enter the connection token",
            password: true,
        });
        return raw;
    }

    async resolveHost(label: string): Promise<PlainHostItem> {
        const hosts = (await this.getHostList()).filter((h: PlainHostItem) => {
            return h.label === label
        });

        if (!hosts || hosts.length === 0) {
            throw RemoteAuthorityResolverError.NotAvailable(`Host ${label} is not configured.`, true);
        }

        return hosts[0];
    }


    async resolveAuthority(
        { type, host, port }: HostInfo,
        channel: OutputChannel,
    ): Promise<ResolvedAuthority> {
        channel.appendLine(`resolving host '${host}'...`);

        if (type === "transient") {
            channel.appendLine(`resolved transient host to '${host}:${port}'...`);
            const token = await this.pickToken();
            if (!token) {
                return new ResolvedAuthority(host, port!);
            }
            return new ResolvedAuthority(host, port!, token);
        }

        // Configured host
        const resolvedHost = await this.resolveHost(host);

        channel.appendLine(`resolved host to '${resolvedHost.label}'...`);

        if (resolvedHost instanceof PlainHostItem) {
            if (typeof resolvedHost.connectionToken === "boolean") {
                if (!resolvedHost.connectionToken) {
                    return new ResolvedAuthority(resolvedHost.host, resolvedHost.port);
                } else {
                    const token = await this.pickToken();
                    if (!token) {
                        throw new Error("no token specified");
                    }
                    return new ResolvedAuthority(resolvedHost.host, resolvedHost.port, token);
                }
            } else {
                return new ResolvedAuthority(resolvedHost.host, resolvedHost.port, resolvedHost.connectionToken);
            }
        }
        throw RemoteAuthorityResolverError.NotAvailable(`Host ${host} is not configured.`, true);
    }
}
