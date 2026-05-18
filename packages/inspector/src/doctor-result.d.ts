export declare enum DoctorSeverity {
    Ok = "ok",
    Info = "info",
    Warning = "warning",
    Error = "error"
}
export interface IDoctorCheck {
    id: string;
    title: string;
    severity: DoctorSeverity;
    message: string;
    fix?: string;
}
export interface IDoctorResult {
    passed: boolean;
    checks: readonly IDoctorCheck[];
    summary: {
        ok: number;
        info: number;
        warnings: number;
        errors: number;
    };
}
//# sourceMappingURL=doctor-result.d.ts.map