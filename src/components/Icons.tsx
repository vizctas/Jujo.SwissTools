/* Íconos en línea. Un solo trazo, 16px, currentColor: mismo estilo en toda la navaja. */

import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M3 8.5 6.2 12 13 4.5" />
  </Icon>
);

export const AlertIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M8 2.6 14.6 13.4H1.4z" />
    <path d="M8 6.6v3.1" />
    <path d="M8 11.7h.01" />
  </Icon>
);

export const BrokenIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M5.7 5.7 10.3 10.3M10.3 5.7 5.7 10.3" />
  </Icon>
);

export const InfoIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.4v3.4M8 5.2h.01" />
  </Icon>
);

export const CubeIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M8 1.8 13.8 5v6L8 14.2 2.2 11V5z" />
    <path d="M2.4 5.2 8 8.3l5.6-3.1M8 8.3v5.8" />
  </Icon>
);

export const ChevronIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </Icon>
);

export const TargetIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="4.2" />
    <path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2" />
  </Icon>
);

export const SearchIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <circle cx="7.2" cy="7.2" r="4.4" />
    <path d="m10.6 10.6 3 3" />
  </Icon>
);

export const DownloadIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M8 2.5v7.6" />
    <path d="m5 7.4 3 3 3-3" />
    <path d="M2.8 12.4h10.4" />
  </Icon>
);

export const UploadIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M8 10.6V3" />
    <path d="m5 6.1 3-3 3 3" />
    <path d="M2.8 12.4h10.4" />
  </Icon>
);

export const TrashIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M2.8 4.2h10.4" />
    <path d="M5.6 4.2V2.9h4.8v1.3" />
    <path d="M4.2 4.2 4.8 13h6.4l.6-8.8" />
  </Icon>
);

export const SunIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1" />
  </Icon>
);

export const MoonIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8a5.6 5.6 0 1 0 6.6 6.6" />
  </Icon>
);

export const MonitorIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.2" />
    <path d="M5.6 13.6h4.8" />
  </Icon>
);

export const GridIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="0.8" />
    <rect x="9" y="2.4" width="4.6" height="4.6" rx="0.8" />
    <rect x="2.4" y="9" width="4.6" height="4.6" rx="0.8" />
    <path d="M9.6 10.4h1.4M12.4 10.4h1.2M9.6 13.2h2.6M13.2 12.6v1" />
  </Icon>
);

export const SaveIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M2.8 3.9a1.1 1.1 0 0 1 1.1-1.1h6.6l2.7 2.7v6.6a1.1 1.1 0 0 1-1.1 1.1H3.9a1.1 1.1 0 0 1-1.1-1.1z" />
    <path d="M5.4 2.8v3.4h4.2V2.8" />
    <path d="M5.4 13.2V9.4h5.2v3.8" />
  </Icon>
);

export const HistoryIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M2.4 8a5.6 5.6 0 1 0 1.7-4" />
    <path d="M2.2 2.4v2.4h2.4" />
    <path d="M8 5.2V8l2 1.4" />
  </Icon>
);

export const PipetteIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="m9.4 4.2 2.4 2.4" />
    <path d="M10.1 2.3a1.8 1.8 0 0 1 2.5 0l1.1 1.1a1.8 1.8 0 0 1 0 2.5l-1 1-3.6-3.6z" />
    <path d="M8.4 4.9 3.1 10.2l-.6 3.3 3.3-.6L11.1 7.6" />
  </Icon>
);

export const CloseIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const PhoneIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <rect x="4.2" y="1.8" width="7.6" height="12.4" rx="1.4" />
    <path d="M7.2 12.2h1.6" />
  </Icon>
);

export const WirelessIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M2.4 6.2a8 8 0 0 1 11.2 0" />
    <path d="M4.7 8.7a4.8 4.8 0 0 1 6.6 0" />
    <path d="M8 11.9h.01" />
  </Icon>
);

export const PackageIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M8 1.9 14 5v6l-6 3.1L2 11V5z" />
    <path d="M2 5l6 3.1L14 5" />
    <path d="M8 8.1v6" />
  </Icon>
);

export const RefreshIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
    <path d="M13.6 2.4v3.2h-3.2" />
  </Icon>
);

export const StopIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" />
  </Icon>
);

export const PlugIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M6 1.8v3.4M10 1.8v3.4" />
    <path d="M3.8 5.2h8.4v2.2a4.2 4.2 0 0 1-8.4 0z" />
    <path d="M8 11.6v2.6" />
  </Icon>
);

export const KnifeIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M13.5 2.5 3 13" />
    <path d="M3 13c1.5 0 3-1 3.5-2.5L10 6" />
  </Icon>
);

export const PenIcon = (props: IconProps): ReactNode => (
  <Icon {...props}>
    <path d="M3 13c2-6 5-9 8-10" />
    <path d="M11 3l2 2-6.5 6.5L4 12l.5-2.5z" />
  </Icon>
);
