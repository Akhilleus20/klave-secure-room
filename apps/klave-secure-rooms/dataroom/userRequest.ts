import { Ledger, JSON, Crypto, Context } from "@klave/sdk";
import { success, error } from "../klave/types"
import { encode as b64encode } from 'as-base64/assembly';

const UserRequestsTable = "UserRequestsTable";

/**
 * Roles of the user in the wallet
 * - admin: can manage the wallet and its users
 * - internal user: can sign and verify transactions
 * - external user: can only sign transactions
 **/
@JSON
export class UserRequest {
    id: string;
    userId: string;
    dataRoomId: string;
    role: string;

    constructor(dataRoomId: string, role: string) {
        this.id = b64encode(Crypto.getRandomValues(64)!);
        this.userId = Context.get('sender');
        this.dataRoomId = dataRoomId;
        this.role = role;
    }

    static load(id: string) : UserRequest | null {
        let userTable = Ledger.getTable(UserRequestsTable).get(id);
        if (userTable.length == 0) {
            error(`UserRequest ${id} does not exist. Create it first`);
            return null;
        }
        let user = JSON.parse<UserRequest>(userTable);
        // success(`UserRequest profile loaded successfully: '${user.id}'`);
        return user;
    }

    save(): void {
        let userTable = JSON.stringify<UserRequest>(this);
        Ledger.getTable(UserRequestsTable).set(this.id, userTable);
        // success(`UserRequest saved successfully: '${this.id}'`);
    }

    delete(): void {
        this.dataRoomId = "";
        this.role = "";
        Ledger.getTable(UserRequestsTable).unset(this.id);
        success(`UserRequest deleted successfully: ${this.id}`);
        this.id = "";
    }
}