import styled from "styled-components";
import { forwardRef } from "react";

const StyledButton = styled.button<{ $variant: "primary" | "secondary" }>`
  background: ${({ $variant }) => ($variant === "primary" ? "#3366ff" : "#eee")};
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
`;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", ...props }, ref) => (
    <StyledButton ref={ref} $variant={variant} {...props} />
  ),
);

Button.displayName = "Button";
