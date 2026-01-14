"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const acumaticaBaseUrl = process.env.ACUMATICA_BASE_URL;
class AcumaticaService {
    constructor(baseUrl, clientId, clientSecret, username, password) {
        this.baseUrl = baseUrl || acumaticaBaseUrl || "";
        if (!this.baseUrl) {
            throw new Error("ACUMATICA_BASE_URL is not set");
        }
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.username = username;
        this.password = password;
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
    }
    // Method to get or refresh the token
    async getToken() {
        try {
            // If token is valid, return it
            if (this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now()) {
                console.log("Using existing access token");
                return this.accessToken;
            }
            console.log("Fetching new token...");
            const url = `${this.baseUrl}/identity/connect/token`;
            const body = new URLSearchParams({
                grant_type: this.refreshToken ? "refresh_token" : "password",
                client_id: this.clientId,
                client_secret: this.clientSecret,
            });
            if (this.refreshToken) {
                body.append("refresh_token", this.refreshToken);
            }
            else {
                body.append("username", this.username);
                body.append("password", this.password);
                body.append("scope", "api offline_access");
            }
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body.toString(),
            });
            const data = (await response.json());
            if (!response.ok) {
                console.error("Token request failed:", data);
                throw new Error(`Token request failed: ${data.error || data.error_description}`);
            }
            // Store the token and expiry
            this.accessToken = data.access_token;
            this.refreshToken = data.refresh_token ?? null;
            this.tokenExpiry = Date.now() + data.expires_in * 1000; // Token expiration in milliseconds
            console.log("Access token fetched successfully");
            return this.accessToken;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Error fetching token:", message);
            throw error;
        }
    }
    // PUT request method
    async put(entityName, entity) {
        try {
            const url = `${this.baseUrl}/entity/CustomEndpoint/24.200.001/${entityName}`;
            console.log("Making PUT request to:", url);
            console.log("Payload:", JSON.stringify(entity, null, 2));
            const response = await fetch(url, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${await this.getToken()}`, // Add the access token
                },
                body: JSON.stringify(entity),
            });
            const data = (await response.json());
            if (!response.ok) {
                console.error("PUT request failed:", data);
                return { success: false, data };
            }
            console.log("PUT request succeeded:", data);
            return { success: true, data };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Error during PUT request:", message);
            throw error;
        }
    }
}
exports.default = AcumaticaService;
